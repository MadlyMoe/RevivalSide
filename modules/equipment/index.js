const { dateTimeBinaryNow, statTypeName, toBigInt } = require("../packet-codec");
const {
  getEquipTemplet,
  getAllEquipIds,
  getEquipEnchantFeedExp,
  getEquipEnchantMaterials,
  getEquipEnchantRequiredExp,
  getEquipMoldTemplet,
  getEquipPotentialOptionRecords,
  getEquipPrecisionWeightRecords,
  getEquipRandomStatRecords,
  getAllEquipRandomStatRecords,
  getEquipSetOptionIds,
  getEquipUpgradeTemplet,
  getMaxEquipEnchantLevel,
  getMoldRewardRecords,
  getRandomEquipId,
  getRelicRerollCountFactor,
} = require("../game-data");
const { ensureInventory, getMiscItem, grantMiscItem, spendMiscItem } = require("../inventory");
const { ensureArmy } = require("../unit");

const DEFAULT_NEXT_EQUIP_UID = 9100000000000001n;
const TICKS_AT_UNIX_EPOCH = 621355968000000000n;
const DATE_TIME_LOCAL_MASK = 0x4000000000000000n;
const DATE_TIME_TICKS_MASK = 0x3fffffffffffffffn;
const MAX_CRAFT_SLOTS = 5;
const DEFAULT_UNLOCKED_CRAFT_SLOTS = 1;
const CRAFT_SLOT_UNLOCK_ITEM_ID = 101;
const CRAFT_SLOT_UNLOCK_COST = 300;
const CREDIT_ITEM_ID = 1;
const CRAFT_INSTANT_COMPLETE_ITEM_ID = 1012;
const MAX_EQUIP_CRAFT_COUNT = 10;
const MAX_MATERIAL_CRAFT_COUNT = 999;
const TUNING_MATERIAL_ITEM_ID = 1013;
const TUNING_BONUS_RESET_GROUP_ID = 1013;
const SET_BONUS_RESET_GROUP_ID = 1035;
const TUNING_BONUS_MAX_COUNT = 100;
const DEFAULT_PRECISION_WEIGHT_ID = 10000;
const ENCHANT_CREDIT_PER_EXP = 8;
const DEFAULT_STAT_TYPES = Object.freeze([
  "NST_ATK",
  "NST_HP",
  "NST_DEF",
  "NST_ATTACK_SPEED_RATE",
  "NST_SKILL_COOL_TIME_REDUCE_RATE",
  "NST_DAMAGE_REDUCE_RATE",
]);
const CRAFT_ERROR = Object.freeze({
  OK: 0,
  INSUFFICIENT_RESOURCE: 110,
  INSUFFICIENT_ITEM: 111,
  INVALID_SLOT_INDEX: 295,
  NOT_ENOUGH_MOLD: 296,
  MOLD_TEMPLET_NOT_FOUND: 297,
  SLOT_ALREADY_COMPLETED: 298,
  SLOT_ALREADY_UNLOCKED_MAX: 300,
  SLOT_NOT_COMPLETED: 301,
  SLOT_NOT_EMPTY: 302,
  SLOT_NOT_CREATING: 303,
  EXCEEDED_MAX_START_COUNT: 304,
});
const EQUIP_CRAFT_TABS = new Set([
  "MT_EQUIP",
  "MT_EQUIP_PRIVATE",
  "MT_EQUIP_RELIC",
  "MT_EQUIP_RAID",
  "MT_EQUIP_RAID_2",
]);
const EQUIP_POSITION_INDEX = Object.freeze({
  IEP_WEAPON: 0,
  IEP_DEFENCE: 1,
  IEP_ACC: 2,
  IEP_ACC2: 3,
});
const EQUIP_PRESET_TYPE = Object.freeze({
  INVALID: 0,
  NONE: 1,
  COUNTER: 2,
  SOLDIER: 3,
  MECHANIC: 4,
});
const EQUIP_PRESET_TYPE_BY_STYLE = Object.freeze({
  NUST_COUNTER: EQUIP_PRESET_TYPE.COUNTER,
  NUST_SOLDIER: EQUIP_PRESET_TYPE.SOLDIER,
  NUST_MECHANIC: EQUIP_PRESET_TYPE.MECHANIC,
});

function ensureEquipInventory(user) {
  const inventory = ensureInventory(user);
  inventory.equips = inventory.equips && typeof inventory.equips === "object" ? inventory.equips : {};
  inventory.equipPresets = Array.isArray(inventory.equipPresets) ? inventory.equipPresets : [];
  user.nextEquipUid = String(toBigInt(user.nextEquipUid, DEFAULT_NEXT_EQUIP_UID));

  for (const [key, value] of Object.entries(inventory.equips)) {
    const equip = normalizeEquip(value);
    if (!equip) {
      delete inventory.equips[key];
      continue;
    }
    if (String(key) !== String(equip.equipUid)) delete inventory.equips[key];
    inventory.equips[String(equip.equipUid)] = equip;
  }
  if (reconcileEquipOwnership(user, inventory)) markInventoryTouched(inventory);
  normalizeEquipPresets(inventory);
  return inventory;
}

function getEquipItems(user) {
  const inventory = ensureEquipInventory(user);
  return Object.values(inventory.equips)
    .map(normalizeEquip)
    .filter(Boolean)
    .sort((a, b) => Number(toBigInt(a.equipUid) - toBigInt(b.equipUid)));
}

function getEquipItem(user, equipUid) {
  const inventory = ensureEquipInventory(user);
  const equip = normalizeEquip(inventory.equips[String(toBigInt(equipUid))]);
  if (equip) inventory.equips[String(equip.equipUid)] = equip;
  return equip;
}

function ensureCraftData(user) {
  user.craft = user.craft && typeof user.craft === "object" ? user.craft : {};
  user.craft.molds = user.craft.molds && typeof user.craft.molds === "object" ? user.craft.molds : {};
  user.craft.slots = user.craft.slots && typeof user.craft.slots === "object" ? user.craft.slots : {};

  for (const [key, value] of Object.entries(user.craft.molds)) {
    const mold = normalizeMoldItem(value, key);
    if (!mold) {
      delete user.craft.molds[key];
      continue;
    }
    if (String(key) !== String(mold.moldId)) delete user.craft.molds[key];
    user.craft.molds[String(mold.moldId)] = mold;
  }

  for (const [key, value] of Object.entries(user.craft.slots)) {
    const slot = normalizeCraftSlot(value, key);
    if (!slot || slot.index < 1 || slot.index > MAX_CRAFT_SLOTS) {
      delete user.craft.slots[key];
      continue;
    }
    if (String(key) !== String(slot.index)) delete user.craft.slots[key];
    user.craft.slots[String(slot.index)] = slot;
  }

  for (let index = 1; index <= DEFAULT_UNLOCKED_CRAFT_SLOTS; index += 1) {
    if (!user.craft.slots[String(index)]) user.craft.slots[String(index)] = createEmptyCraftSlot(index);
  }
  return user.craft;
}

function getMoldItems(user) {
  return Object.values(ensureCraftData(user).molds)
    .map((mold) => normalizeMoldItem(mold))
    .filter(Boolean)
    .sort((a, b) => a.moldId - b.moldId);
}

function getCraftSlots(user) {
  return Object.values(ensureCraftData(user).slots)
    .map((slot) => normalizeCraftSlot(slot))
    .filter(Boolean)
    .sort((a, b) => a.index - b.index);
}

function grantMoldItem(user, moldId, count = 1) {
  const moldTemplet = getEquipMoldTemplet(moldId);
  const numericMoldId = Number(moldId);
  if (!moldTemplet || !Number.isInteger(numericMoldId) || numericMoldId <= 0) return null;
  const craft = ensureCraftData(user);
  const key = String(numericMoldId);
  const existing = normalizeMoldItem(craft.molds[key], key) || { moldId: numericMoldId, count: "0" };
  existing.count = (toBigInt(existing.count) + toBigInt(count, 0n)).toString();
  craft.molds[key] = existing;
  return existing;
}

function startCraft(user, slotIndex, moldId, count = 1, options = {}) {
  const craft = ensureCraftData(user);
  const slot = getExistingCraftSlot(user, slotIndex);
  const moldTemplet = getEquipMoldTemplet(moldId);
  if (!slot) return craftResult({ errorCode: CRAFT_ERROR.INVALID_SLOT_INDEX });
  if (!moldTemplet) return craftResult({ errorCode: CRAFT_ERROR.MOLD_TEMPLET_NOT_FOUND, slot });
  if (Number(slot.moldId || 0) > 0) {
    const state = getCraftSlotState(slot, dateTimeTicksNow(options.regDate));
    return craftResult({
      errorCode: state === "completed" ? CRAFT_ERROR.SLOT_ALREADY_COMPLETED : CRAFT_ERROR.SLOT_NOT_EMPTY,
      slot,
    });
  }

  const craftCount = normalizeCraftCount(count);
  const maxCount = maxCraftStartCount(moldTemplet);
  if (craftCount > maxCount) return craftResult({ errorCode: CRAFT_ERROR.EXCEEDED_MAX_START_COUNT, slot });

  const isPermanent = moldTemplet.m_bPermanent === true;
  const moldKey = String(Number(moldId));
  const moldCount = toBigInt((craft.molds[moldKey] || {}).count, 0n);
  if (!isPermanent && moldCount < BigInt(craftCount)) {
    return craftResult({ errorCode: CRAFT_ERROR.NOT_ENOUGH_MOLD, slot });
  }

  const materialCosts = getMoldMaterialCosts(moldTemplet, craftCount);
  const materialErrorCode = getCraftMaterialErrorCode(user, materialCosts);
  if (materialErrorCode !== CRAFT_ERROR.OK) return craftResult({ errorCode: materialErrorCode, slot });

  if (!isPermanent) {
    const next = moldCount - BigInt(craftCount);
    craft.molds[moldKey] = { moldId: Number(moldId), count: (next > 0n ? next : 0n).toString() };
  }
  const costs = spendMiscCosts(user, materialCosts, options);
  slot.moldId = Number(moldId);
  slot.count = craftCount;
  slot.completeDate = (dateTimeTicksNow(options.regDate) + BigInt(Math.max(0, Number(moldTemplet.m_Time || 0)) * 60 * 10000000)).toString();
  craft.slots[String(slot.index)] = slot;
  return craftResult({ slot, costItems: costs });
}

function completeCraft(user, slotIndex, options = {}) {
  const craft = ensureCraftData(user);
  const slot = getExistingCraftSlot(user, slotIndex);
  if (!slot) return craftResult({ errorCode: CRAFT_ERROR.INVALID_SLOT_INDEX });
  if (Number(slot.moldId || 0) <= 0) return craftResult({ errorCode: CRAFT_ERROR.SLOT_NOT_CREATING, slot });
  if (options.force !== true && getCraftSlotState(slot, dateTimeTicksNow(options.regDate)) !== "completed") {
    return craftResult({ errorCode: CRAFT_ERROR.SLOT_NOT_COMPLETED, slot });
  }
  const reward = createMoldReward(user, slot.moldId, slot.count, options);
  const completedSlot = createEmptyCraftSlot(slot.index);
  craft.slots[String(slot.index)] = completedSlot;
  return craftResult({ slot: completedSlot, reward });
}

function instantCraft(user, moldId, count = 1, options = {}) {
  const moldTemplet = getEquipMoldTemplet(moldId);
  const craftCount = normalizeCraftCount(count);
  if (!moldTemplet) {
    return craftResult({
      errorCode: CRAFT_ERROR.MOLD_TEMPLET_NOT_FOUND,
      moldId: Number(moldId || 0),
      moldCount: craftCount,
    });
  }
  const maxCount = maxCraftStartCount(moldTemplet);
  if (craftCount > maxCount) {
    return craftResult({
      errorCode: CRAFT_ERROR.EXCEEDED_MAX_START_COUNT,
      moldId: Number(moldId || 0),
      moldCount: craftCount,
    });
  }
  const craft = ensureCraftData(user);
  const moldKey = String(Number(moldId));
  const moldCount = toBigInt((craft.molds[moldKey] || {}).count, 0n);
  if (moldTemplet.m_bPermanent !== true && moldCount < BigInt(craftCount)) {
    return craftResult({
      errorCode: CRAFT_ERROR.NOT_ENOUGH_MOLD,
      moldId: Number(moldId || 0),
      moldCount: craftCount,
    });
  }

  const materialCosts = getMoldMaterialCosts(moldTemplet, craftCount);
  const materialErrorCode = getCraftMaterialErrorCode(user, materialCosts);
  if (materialErrorCode !== CRAFT_ERROR.OK) {
    return craftResult({
      errorCode: materialErrorCode,
      moldId: Number(moldId || 0),
      moldCount: craftCount,
    });
  }

  if (moldTemplet.m_bPermanent !== true) {
    const next = moldCount - BigInt(craftCount);
    craft.molds[moldKey] = { moldId: Number(moldId), count: (next > 0n ? next : 0n).toString() };
  }
  const costItems = spendMiscCosts(user, materialCosts, options);
  const reward = createMoldReward(user, moldId, craftCount, options);
  return craftResult({ moldId: Number(moldId), moldCount: craftCount, reward, costItems });
}

function instantCompleteCraft(user, slotIndex, options = {}) {
  const slot = getExistingCraftSlot(user, slotIndex);
  if (!slot) return craftResult({ errorCode: CRAFT_ERROR.INVALID_SLOT_INDEX });
  if (Number(slot.moldId || 0) <= 0) return craftResult({ errorCode: CRAFT_ERROR.SLOT_NOT_CREATING, slot });
  if (!hasMiscItemCount(user, CRAFT_INSTANT_COMPLETE_ITEM_ID, 1)) {
    return craftResult({ errorCode: CRAFT_ERROR.INSUFFICIENT_ITEM, slot });
  }
  const cost = spendMiscItem(user, CRAFT_INSTANT_COMPLETE_ITEM_ID, 1, { regDate: options.regDate });
  const result = completeCraft(user, slotIndex, { ...options, force: true });
  result.extraCostItem = cost;
  return result;
}

function unlockCraftSlot(user, options = {}) {
  const craft = ensureCraftData(user);
  for (let index = 1; index <= MAX_CRAFT_SLOTS; index += 1) {
    if (!craft.slots[String(index)]) {
      if (!hasMiscItemCount(user, CRAFT_SLOT_UNLOCK_ITEM_ID, CRAFT_SLOT_UNLOCK_COST)) {
        return craftResult({ errorCode: CRAFT_ERROR.INSUFFICIENT_RESOURCE });
      }
      const cost = spendMiscItem(user, CRAFT_SLOT_UNLOCK_ITEM_ID, CRAFT_SLOT_UNLOCK_COST, { regDate: options.regDate });
      const slot = createEmptyCraftSlot(index);
      craft.slots[String(index)] = slot;
      return craftResult({ slot, costItems: cost ? [cost] : [] });
    }
  }
  return craftResult({ errorCode: CRAFT_ERROR.SLOT_ALREADY_UNLOCKED_MAX });
}

function grantEquipItem(user, equipId, options = {}) {
  if (!user) return null;
  let numericEquipId = Number(equipId);
  if (!Number.isInteger(numericEquipId) || numericEquipId <= 0) {
    numericEquipId = getRandomEquipId(Number(user.localEquipGrantCursor || 0));
    user.localEquipGrantCursor = Number(user.localEquipGrantCursor || 0) + 1;
  }
  const templet = getEquipTemplet(numericEquipId);
  if (!templet) return null;

  const inventory = ensureEquipInventory(user);
  const equipUid = allocateEquipUid(user);
  const equip = createEquipData(numericEquipId, equipUid, {
    ...options,
    cursor: Number(user.localEquipStatCursor || 0),
  });
  user.localEquipStatCursor = Number(user.localEquipStatCursor || 0) + 1;
  inventory.equips[equip.equipUid] = equip;
  markInventoryTouched(inventory);
  return equip;
}

function createEquipData(equipId, equipUid, options = {}) {
  const templet = getEquipTemplet(equipId) || {};
  const customMainStat = normalizeCustomMainStat(options.customMainStat);
  const customSubstats = normalizeCustomSubstats(options.customSubstats);
  const cursor = Number(options.cursor || 0);
  const precision1 = normalizePrecision(
    options.precision != null ? options.precision : rollInitialPrecision(templet, 1, { ...options, equipUid, cursor })
  );
  const precision2 = normalizePrecision(
    options.precision2 != null ? options.precision2 : rollInitialPrecision(templet, 2, { ...options, equipUid, cursor: cursor + 1 })
  );
  const stats = [customMainStat ? buildCustomMainStat(templet, customMainStat) : defaultMainStat(templet, options)];
  for (let slot = 1; slot <= 2; slot += 1) {
    const groupId = slot === 1 ? templet.m_StatGroupID : templet.m_StatGroupID_2;
    const precision = slot === 1 ? precision1 : precision2;
    const custom = customSubstats.find((entry) => Number(entry.slot) === slot);
    if (Number(groupId || 0) <= 0) continue;
    const rolled = custom
      ? buildCustomSubstat(groupId, custom, { overrideUnsupportedSubstats: options.overrideUnsupportedSubstats, precision })
      : rollStatFromGroup(groupId, cursor + slot - 1, precision);
    if (rolled) stats.push(rolled);
  }

  return normalizeEquip({
    equipUid: equipUid.toString(),
    itemEquipId: Number(equipId),
    ownerUnitUid: "-1",
    enchantLevel: Number(options.enchantLevel || 0),
    enchantExp: Number(options.enchantExp || 0),
    stats,
    locked: Boolean(options.locked),
    precision: precision1,
    precision2: precision2,
    setOptionId: Number(options.setOptionId || pickSetOptionId(templet, options.cursor || 0)),
    imprintUnitId: Number(options.imprintUnitId || 0),
    potentialOptions: options.potentialOptions || buildDefaultPotentialOptions(templet),
    regDate: String(options.regDate || dateTimeBinaryNow()),
  });
}

function removeEquipItems(user, equipUids) {
  const inventory = ensureEquipInventory(user);
  const army = ensureArmy(user);
  const removed = [];
  for (const equipUid of Array.isArray(equipUids) ? equipUids : []) {
    const key = String(toBigInt(equipUid));
    const equip = normalizeEquip(inventory.equips[key]);
    if (!equip || equip.locked) continue;
    unequipFromAnyUnit(army, key);
    delete inventory.equips[key];
    removed.push(key);
  }
  if (removed.length) markInventoryTouched(inventory);
  return removed;
}

function equipItemToUnit(user, unitUid, equipUid, position = null) {
  const inventory = ensureEquipInventory(user);
  const army = ensureArmy(user);
  const key = String(toBigInt(equipUid));
  const equip = normalizeEquip(inventory.equips[key]);
  const unit = getUnitByUid(army, unitUid);
  const fallbackPosition = equip ? inferEquipPosition(equip) : 0;
  if (!equip || !unit) return { equip: equip || null, unit: unit || null, unequipItemUID: "0", position: normalizePosition(position, fallbackPosition) };

  const slot = normalizePosition(position, fallbackPosition);
  const previousOwner = findEquipOwnerUnit(army, key);
  unit.equipItemUids = normalizeFixedArray(unit.equipItemUids, 4, 0);
  const currentSlotEquipUid = String(toBigInt(unit.equipItemUids[slot] || 0));
  const unequipItemUID = currentSlotEquipUid === key ? "0" : currentSlotEquipUid;
  if (unequipItemUID !== "0" && inventory.equips[unequipItemUID]) inventory.equips[unequipItemUID].ownerUnitUid = "-1";
  unequipFromAnyUnit(army, key);
  unit.equipItemUids[slot] = key;
  equip.ownerUnitUid = String(toBigInt(unit.unitUid));
  inventory.equips[key] = equip;
  markInventoryTouched(inventory);
  return {
    equip,
    unit,
    unequipItemUID,
    position: slot,
    previousOwnerUnit: previousOwner && previousOwner.unit,
    previousOwnerPosition: previousOwner && previousOwner.position,
  };
}

function unequipItem(user, equipUid) {
  const inventory = ensureEquipInventory(user);
  const army = ensureArmy(user);
  const key = String(toBigInt(equipUid));
  const equip = normalizeEquip(inventory.equips[key]);
  const owner = findEquipOwnerUnit(army, key);
  const detachedOwnerCleared = !owner && equip && toBigInt(equip.ownerUnitUid) > 0n;
  const position = owner && owner.position != null ? owner.position : equip ? inferEquipPosition(equip) : 0;
  unequipFromAnyUnit(army, key);
  if (equip) {
    equip.ownerUnitUid = "-1";
    inventory.equips[key] = equip;
  }
  markInventoryTouched(inventory);
  return { equip, unit: owner && owner.unit, unequipItemUID: key, position, detachedOwnerCleared };
}

function lockEquipItem(user, equipUid, isLock) {
  const equip = getEquipItem(user, equipUid);
  if (!equip) return null;
  equip.locked = Boolean(isLock);
  ensureEquipInventory(user).equips[equip.equipUid] = equip;
  markInventoryTouched(user.inventory);
  return equip;
}

function enchantEquipItem(user, equipUid, consumeEquipUids = [], options = {}) {
  const equip = getEquipItem(user, equipUid);
  if (!equip) return null;
  const materialEquips = (Array.isArray(consumeEquipUids) ? consumeEquipUids : [])
    .map((uid) => getEquipItem(user, uid))
    .filter((item) => item && String(item.equipUid) !== String(equip.equipUid));
  let addedExp = materialEquips.reduce((total, item) => total + getEquipFeedExpForItem(item), 0);
  const miscItems = normalizeMiscItemList(options.miscItems || []);
  for (const item of miscItems) addedExp += getMiscEnchantExp(item.itemId) * item.count;
  const targetLevel = Number(options.targetLevel || 0);
  if (targetLevel > Number(equip.enchantLevel || 0) && addedExp <= 0) {
    addedExp = getNeededEnchantExp(equip, targetLevel);
  }

  const costItems = [];
  for (const item of miscItems) {
    const spent = spendMiscItem(user, item.itemId, item.count, { regDate: options.regDate });
    if (spent) costItems.push(spent);
  }
  if (addedExp > 0) {
    const credit = spendMiscItem(user, CREDIT_ITEM_ID, addedExp * ENCHANT_CREDIT_PER_EXP, { regDate: options.regDate });
    if (credit) costItems.push(credit);
  }

  const consumed = removeEquipItems(user, materialEquips.map((item) => item.equipUid));
  applyEquipEnchantExp(equip, addedExp);
  ensureEquipInventory(user).equips[equip.equipUid] = equip;
  markInventoryTouched(user.inventory);
  return { equip, consumed, costItems };
}

function rollEquipPrecision(user, equipUid, optionId = 0, options = {}) {
  const equip = getEquipItem(user, equipUid);
  if (!equip) return null;
  const templet = getEquipTemplet(equip.itemEquipId) || {};
  const slot = normalizeOptionSlot(optionId);
  const current = Number(slot === 2 ? equip.precision2 : equip.precision) || 0;
  const outcome = current >= 100 ? { refineResult: 0, precision: current } : rollPrecisionOutcome(user, equip, slot, current);
  const costItems = current >= 100 ? [] : spendMiscCosts(user, getPrecisionCosts(templet), options);
  const next = normalizePrecision(outcome.precision);
  if (slot === 2) equip.precision2 = next;
  else equip.precision = next;
  updateStatValueForPrecision(equip, slot);
  ensureEquipInventory(user).equips[equip.equipUid] = equip;
  markInventoryTouched(user.inventory);
  return { equip, precision: next, costItems, refineResult: outcome.refineResult };
}

function rollEquipSubstat(user, equipUid, optionId = 0, forcedStatType = null, options = {}) {
  const equip = getEquipItem(user, equipUid);
  if (!equip) return null;
  const templet = getEquipTemplet(equip.itemEquipId) || {};
  const costItems = forcedStatType ? [] : spendMiscCosts(user, getRandomStatCosts(templet), options);
  const slot = normalizeOptionSlot(optionId);
  const groupId = slot === 2 ? templet.m_StatGroupID_2 : templet.m_StatGroupID;
  const precision = getPrecisionForSlot(equip, slot);
  const currentType = equip.stats && equip.stats[slot] && equip.stats[slot].type;
  const cursor = Number(user.localEquipStatCursor || 0);
  user.localEquipStatCursor = cursor + 1;
  const rolled = forcedStatType
    ? statForType(forcedStatType, groupId, null, precision)
    : rollStatFromGroup(groupId, cursor, precision, currentType) || rollFallbackStat(cursor);
  equip.tuningCandidate = {
    equipUid: equip.equipUid,
    option1: slot === 1 ? rolled.type : "NST_RANDOM",
    option2: slot === 2 ? rolled.type : "NST_RANDOM",
    setOptionId: 0,
    slot,
    stat: rolled,
  };
  const resetCount = forcedStatType
    ? setEquipResetCount(user, TUNING_BONUS_RESET_GROUP_ID, 0)
    : incrementEquipResetCount(user, TUNING_BONUS_RESET_GROUP_ID, TUNING_BONUS_MAX_COUNT);
  ensureEquipInventory(user).equips[equip.equipUid] = equip;
  markInventoryTouched(user.inventory);
  return { equip, candidate: equip.tuningCandidate, costItems, resetCount };
}

function validateEquipCustomSubstats(equipId, customSubstats = [], options = {}) {
  const templet = getEquipTemplet(equipId);
  if (!templet) return { ok: false, unsupported: [], substats: [], error: `No gear id ${equipId} exists in local tables.` };
  const substats = normalizeCustomSubstats(customSubstats);
  const unsupported = [];
  for (const substat of substats) {
    const slot = normalizeSubstatSlot(substat.slot);
    const groupId = slot === 1 ? templet.m_StatGroupID : templet.m_StatGroupID_2;
    if (!findStatRecord(groupId, substat.type)) {
      unsupported.push({ slot, type: substat.type, groupId: Number(groupId || 0) });
    }
  }
  return {
    ok: unsupported.length === 0 || options.overrideUnsupportedSubstats === true,
    unsupported,
    substats,
  };
}

function confirmEquipSubstat(user, equipUid, optionId = 0) {
  const equip = getEquipItem(user, equipUid);
  if (!equip) return null;
  const candidate = equip.tuningCandidate || null;
  if (candidate) {
    const templet = getEquipTemplet(equip.itemEquipId) || {};
    const slot = normalizeOptionSlot(optionId || candidate.slot || 1);
    const candidateType = slot === 2 ? candidate.option2 : candidate.option1;
    const normalizedCandidateType = normalizeStatType(candidateType);
    const stat =
      candidate.stat ||
      (normalizedCandidateType && normalizedCandidateType !== "NST_RANDOM"
        ? statForType(normalizedCandidateType, getStatGroupIdForSlot(equip, slot), null, getPrecisionForSlot(equip, slot))
        : null);
    equip.stats = normalizeEquipStats(equip.stats, templet);
    if (stat && slot < equip.stats.length) equip.stats[slot] = stat;
  }
  equip.tuningCandidate = null;
  ensureEquipInventory(user).equips[equip.equipUid] = equip;
  markInventoryTouched(user.inventory);
  return { equip, candidate: emptyTuningCandidate() };
}

function cancelEquipTuning(user) {
  const inventory = ensureEquipInventory(user);
  for (const equip of Object.values(inventory.equips)) {
    if (equip && equip.tuningCandidate) {
      equip.tuningCandidate = null;
    }
  }
  markInventoryTouched(inventory);
  return emptyTuningCandidate();
}

function rollSetOption(user, equipUid, forcedSetOptionId = null, options = {}) {
  const equip = getEquipItem(user, equipUid);
  if (!equip) return null;
  const templet = getEquipTemplet(equip.itemEquipId) || {};
  const costItems = forcedSetOptionId || options.free ? [] : spendMiscCosts(user, getRandomSetCosts(templet), options);
  const setOptionId = Number(forcedSetOptionId || pickSetOptionId(templet, Number(user.localEquipSetCursor || 0), equip.setOptionId));
  user.localEquipSetCursor = Number(user.localEquipSetCursor || 0) + 1;
  equip.tuningCandidate = {
    equipUid: equip.equipUid,
    option1: "NST_RANDOM",
    option2: "NST_RANDOM",
    setOptionId,
  };
  const resetCount = options.skipResetCount
    ? null
    : forcedSetOptionId
      ? setEquipResetCount(user, SET_BONUS_RESET_GROUP_ID, 0)
      : incrementEquipResetCount(user, SET_BONUS_RESET_GROUP_ID, TUNING_BONUS_MAX_COUNT);
  ensureEquipInventory(user).equips[equip.equipUid] = equip;
  markInventoryTouched(user.inventory);
  return { equip, setOptionId, candidate: equip.tuningCandidate, costItems, resetCount };
}

function confirmSetOption(user, equipUid, setOptionId = null) {
  const equip = getEquipItem(user, equipUid);
  if (!equip) return null;
  const candidate = equip.tuningCandidate || null;
  const nextSetId = Number(setOptionId || (candidate && candidate.setOptionId) || equip.setOptionId || 0);
  equip.setOptionId = nextSetId;
  equip.tuningCandidate = null;
  ensureEquipInventory(user).equips[equip.equipUid] = equip;
  markInventoryTouched(user.inventory);
  return { equip, setOptionId: nextSetId, candidate: emptyTuningCandidate() };
}

function imprintEquip(user, equipUid, unitId) {
  const equip = getEquipItem(user, equipUid);
  if (!equip) return null;
  equip.imprintUnitId = Number(unitId || 0);
  ensureEquipInventory(user).equips[equip.equipUid] = equip;
  markInventoryTouched(user.inventory);
  return equip;
}

function upgradeEquipItem(user, equipUid, consumeEquipUids = [], options = {}) {
  const equip = getEquipItem(user, equipUid);
  if (!equip) return null;
  const upgrade = getEquipUpgradeTemplet(equip.itemEquipId);
  if (!upgrade) return { equip, consumed: [], costItems: [] };
  const costItems = spendMiscCosts(user, getUpgradeMiscCosts(upgrade), options);
  const consumed = removeUpgradeEquipMaterials(user, upgrade, consumeEquipUids);
  const previousStats = normalizeStats(equip.stats);
  equip.itemEquipId = Number(upgrade.UpgradeEquipID || equip.itemEquipId);
  equip.stats = migrateStatsForNewTemplet(previousStats, getEquipTemplet(equip.itemEquipId) || {}, equip);
  equip.potentialOptions = buildDefaultPotentialOptions(getEquipTemplet(equip.itemEquipId) || {});
  ensureEquipInventory(user).equips[equip.equipUid] = equip;
  markInventoryTouched(user.inventory);
  return { equip, consumed, costItems };
}

function openPotentialSocket(user, equipUid, socketIndex, options = {}) {
  const equip = getEquipItem(user, equipUid);
  if (!equip) {
    return null;
  }

  const index = Math.max(0, Math.min(2, Number(socketIndex || 0)));
  const templet = getEquipTemplet(equip.itemEquipId) || {};

  const costItems = spendMiscCosts(user, getSocketOpenCosts(templet, index), options);

  equip.potentialOptions = Array.isArray(equip.potentialOptions) ? equip.potentialOptions : [];
  if (!equip.potentialOptions.length) {
    equip.potentialOptions.push(buildDefaultPotentialOption(equip));
  }

  const option = equip.potentialOptions[0];

  option.sockets = normalizeFixedArray(option.sockets, 3, null);
  if (!option.sockets[index]) {
    const initialOption = pickPotentialOptionRecord(templet, equip, index, 0, 50);

    option.sockets[index] = {
      statValue: initialOption ? initialOption.statValue : 0.01 * (index + 1),
      precision: 50
    };
  }

  ensureEquipInventory(user).equips[equip.equipUid] = equip;
  markInventoryTouched(user.inventory);

  return { equip, costItems };
}

function rollPotentialOption(user, equipUid, socketIndex, options = {}) {
  const equip = getEquipItem(user, equipUid);
  if (!equip) {
    return null;
  }

  const index = Math.max(0, Math.min(2, Number(socketIndex || 0)));
  const templet = getEquipTemplet(equip.itemEquipId) || {};

  const rerollCosts = getPotentialRerollCosts(templet, equip, index);

  const costItems = spendMiscCosts(user, rerollCosts, options);

  const cursor = Number(user.localEquipPotentialCursor || 0);
  user.localEquipPotentialCursor = cursor + 1;

  const optionSeed = pickPotentialOptionRecord(templet, equip, index, cursor, 100);

  const precisionWeightId = Number(optionSeed && optionSeed.precisionWeightId) || DEFAULT_PRECISION_WEIGHT_ID;
  const currentPrecision = getPotentialSocketPrecision(equip, index);

  const precision = rollIncreasingPrecisionFromTable(
    precisionWeightId,
    currentPrecision,
    equip.equipUid,
    equip.itemEquipId,
    index,
    cursor,
    "potential"
  );

  const optionRecord = pickPotentialOptionRecord(templet, equip, index, cursor, precision) || optionSeed;

  equip.potentialCandidate = {
    equipUid: equip.equipUid,
    precision,
    socketIndex: index,
    accumulateCount: 0,
    optionKey: optionRecord ? optionRecord.optionKey : null,
    statType: optionRecord && optionRecord.statType,
    statValue: optionRecord && optionRecord.statValue,
  };

  ensureEquipInventory(user).equips[equip.equipUid] = equip;
  markInventoryTouched(user.inventory);

  return { equip, candidate: equip.potentialCandidate, costItems };
}

function confirmPotentialOption(user, equipUid, socketIndex) {
  const equip = getEquipItem(user, equipUid);
  if (!equip) {
    return null;
  }

  const candidate = equip.potentialCandidate;

  if (candidate) {
    const index = Math.max(0, Math.min(2, Number(socketIndex != null ? socketIndex : candidate.socketIndex || 0)));

    equip.potentialOptions = Array.isArray(equip.potentialOptions) ? equip.potentialOptions : [];
    const createdOption = !equip.potentialOptions.length;
    if (createdOption) {
      equip.potentialOptions.push(buildDefaultPotentialOption(equip));
    }

    const option = equip.potentialOptions[0];

    option.sockets = normalizeFixedArray(option.sockets, 3, null);

    // statType stays consistent across sockets, except on a freshly created
    // option row: there it must describe the stat the confirmed roll came from.
    if (createdOption && candidate.statType) {
      option.statType = candidate.statType;
      if (candidate.optionKey != null) option.optionKey = Number(candidate.optionKey || 0);
    }

    option.sockets[index] = {
      statValue: Number(candidate.statValue != null ? candidate.statValue : Number(candidate.precision || 0) / 10000),
      precision: Number(candidate.precision || 0),
    };
    option.precisionChangeCount = Number(option.precisionChangeCount || 0) + 1;
  }

  equip.potentialCandidate = null;

  ensureEquipInventory(user).equips[equip.equipUid] = equip;
  markInventoryTouched(user.inventory);

  return equip;
}

function getEquipPresets(user) {
  return ensureEquipInventory(user).equipPresets.slice();
}

function addEquipPresets(user, count) {
  const inventory = ensureEquipInventory(user);
  const addCount = Math.max(1, Number(count || 1));
  for (let i = 0; i < addCount; i += 1) {
    const nextIndex = inventory.equipPresets.length;
    inventory.equipPresets.push({ presetIndex: nextIndex, presetType: EQUIP_PRESET_TYPE.NONE, presetName: "", equipUids: [0, 0, 0, 0] });
  }
  normalizeEquipPresets(inventory);
  markInventoryTouched(inventory);
  return inventory.equipPresets.length;
}

function ensureEquipPreset(user, presetIndex) {
  const inventory = ensureEquipInventory(user);
  const index = Math.max(0, Number(presetIndex || 0));
  while (inventory.equipPresets.length <= index) {
    inventory.equipPresets.push({ presetIndex: inventory.equipPresets.length, presetType: EQUIP_PRESET_TYPE.NONE, presetName: "", equipUids: [0, 0, 0, 0] });
  }
  normalizeEquipPresets(inventory);
  return inventory.equipPresets[index];
}

function setEquipPresetName(user, presetIndex, name) {
  const preset = ensureEquipPreset(user, presetIndex);
  preset.presetName = String(name || "").slice(0, 32);
  markInventoryTouched(user.inventory);
  return preset;
}

function registerEquipPreset(user, presetIndex, position, equipUid) {
  const inventory = ensureEquipInventory(user);
  const preset = ensureEquipPreset(user, presetIndex);
  const slots = sanitizePresetEquipUids(inventory, preset.equipUids);
  const key = normalizePresetEquipUid(inventory, equipUid);
  const equip = key !== 0 ? normalizeEquip(inventory.equips[String(key)]) : null;
  const slot = normalizePosition(position, equip ? inferEquipPosition(equip) : 0);
  if (key !== 0) {
    for (let index = 0; index < slots.length; index += 1) {
      if (slots[index] === key) slots[index] = 0;
    }
  }
  slots[slot] = key;
  preset.equipUids = sanitizePresetEquipUids(inventory, slots);
  preset.presetType = inferEquipPresetType(inventory, preset.equipUids);
  markInventoryTouched(inventory);
  return preset;
}

function registerEquipPresetFromUnit(user, unitUid, presetIndex) {
  const inventory = ensureEquipInventory(user);
  const army = ensureArmy(user);
  const unit = getUnitByUid(army, unitUid);
  const preset = ensureEquipPreset(user, presetIndex);
  preset.equipUids = sanitizePresetEquipUids(inventory, unit ? unit.equipItemUids : []);
  preset.presetType = inferEquipPresetType(inventory, preset.equipUids);
  markInventoryTouched(inventory);
  return preset;
}

function applyEquipPreset(user, presetIndex, unitUid) {
  const inventory = ensureEquipInventory(user);
  const preset = ensureEquipPreset(user, presetIndex);
  preset.equipUids = sanitizePresetEquipUids(inventory, preset.equipUids);
  preset.presetType = inferEquipPresetType(inventory, preset.equipUids);
  const targetUnitUid = String(toBigInt(unitUid));
  const update = { unitUid: targetUnitUid, equipUids: normalizeFixedArray(preset.equipUids, 4, 0) };
  const army = ensureArmy(user);
  const unit = getUnitByUid(army, unitUid);
  const affectedUnitUids = new Set([targetUnitUid]);
  if (unit) {
    for (let index = 0; index < 4; index += 1) {
      const currentUnit = getUnitByUid(ensureArmy(user), unitUid);
      const currentSlots = normalizeFixedArray(currentUnit && currentUnit.equipItemUids, 4, 0);
      const equipUid = update.equipUids[index];
      if (toBigInt(equipUid) > 0n) {
        const previousOwner = findEquipOwnerUnit(ensureArmy(user), equipUid);
        if (previousOwner && previousOwner.unit) affectedUnitUids.add(String(toBigInt(previousOwner.unit.unitUid)));
        const currentEquipUid = currentSlots[index];
        if (toBigInt(currentEquipUid || 0) > 0n) {
          const currentOwner = findEquipOwnerUnit(ensureArmy(user), currentEquipUid);
          if (currentOwner && currentOwner.unit) affectedUnitUids.add(String(toBigInt(currentOwner.unit.unitUid)));
        }
        const result = equipItemToUnit(user, unitUid, equipUid, index);
        if (result && result.previousOwnerUnit) affectedUnitUids.add(String(toBigInt(result.previousOwnerUnit.unitUid)));
      } else {
        const currentEquipUid = currentSlots[index];
        if (toBigInt(currentEquipUid || 0) > 0n) {
          const result = unequipItem(user, currentEquipUid);
          if (result && result.unit) affectedUnitUids.add(String(toBigInt(result.unit.unitUid)));
        }
      }
    }
    const updatedUnit = getUnitByUid(ensureArmy(user), unitUid);
    update.equipUids = normalizeFixedArray(updatedUnit ? updatedUnit.equipItemUids : [], 4, 0);
  }
  markInventoryTouched(inventory);
  update.updates = buildUnitEquipUpdates(ensureArmy(user), affectedUnitUids, targetUnitUid, { preferredLast: true });
  return update;
}

function clearEquipPresets(user, presetIndices) {
  const indices = new Set((Array.isArray(presetIndices) ? presetIndices : []).map(Number));
  const inventory = ensureEquipInventory(user);
  for (const preset of inventory.equipPresets) {
    if (indices.has(Number(preset.presetIndex))) {
      preset.equipUids = [0, 0, 0, 0];
      preset.presetType = EQUIP_PRESET_TYPE.NONE;
      preset.presetName = "";
    }
  }
  normalizeEquipPresets(inventory);
  markInventoryTouched(inventory);
  return inventory.equipPresets.slice();
}

function changeEquipPresetIndices(user, changes) {
  const inventory = ensureEquipInventory(user);
  const normalizedChanges = [];
  let maxIndex = inventory.equipPresets.length - 1;
  for (const change of Array.isArray(changes) ? changes : []) {
    const from = Number(change.from != null ? change.from : change.presetIndex);
    const to = Number(change.to != null ? change.to : change.changeIndex);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0) continue;
    normalizedChanges.push({ from, to });
    maxIndex = Math.max(maxIndex, from, to);
  }
  if (normalizedChanges.length) {
    ensureEquipPreset(user, maxIndex);
    const before = inventory.equipPresets.slice();
    const reordered = before.slice();
    const assignedTargets = new Set();
    for (const { from, to } of normalizedChanges) {
      if (from >= before.length || to >= reordered.length || assignedTargets.has(to)) continue;
      reordered[to] = before[from];
      assignedTargets.add(to);
    }
    inventory.equipPresets = reordered;
  }
  normalizeEquipPresets(inventory);
  markInventoryTouched(inventory);
  return inventory.equipPresets.slice();
}

function applyEquipEnchantExp(equip, addedExp) {
  const templet = getEquipTemplet(equip.itemEquipId) || {};
  const tier = Number(templet.m_NKM_ITEM_TIER || 1);
  const grade = templet.m_NKM_ITEM_GRADE || "NIG_N";
  const maxLevel = Math.min(Number(templet.m_MaxEnchantLevel || 10) || 10, getMaxEquipEnchantLevel(tier) || 10, 10);
  let level = Math.max(0, Number(equip.enchantLevel || 0) || 0);
  let exp = Math.max(0, Number(equip.enchantExp || 0) || 0) + Math.max(0, Math.trunc(Number(addedExp) || 0));
  while (level < maxLevel) {
    const required = getEquipEnchantRequiredExp(tier, level, grade);
    if (!Number.isFinite(required) || required <= 0 || exp < required) break;
    exp -= required;
    level += 1;
  }
  if (level >= maxLevel) exp = 0;
  equip.enchantLevel = level;
  equip.enchantExp = exp;
  return equip;
}

function getNeededEnchantExp(equip, targetLevel) {
  const templet = getEquipTemplet(equip.itemEquipId) || {};
  const tier = Number(templet.m_NKM_ITEM_TIER || 1);
  const grade = templet.m_NKM_ITEM_GRADE || "NIG_N";
  const maxLevel = Math.min(Number(templet.m_MaxEnchantLevel || 10) || 10, getMaxEquipEnchantLevel(tier) || 10, 10);
  const target = Math.max(0, Math.min(maxLevel, Math.trunc(Number(targetLevel) || 0)));
  let needed = -Math.max(0, Number(equip.enchantExp || 0) || 0);
  for (let level = Math.max(0, Number(equip.enchantLevel || 0) || 0); level < target; level += 1) {
    const required = getEquipEnchantRequiredExp(tier, level, grade);
    if (!Number.isFinite(required) || required <= 0) break;
    needed += required;
  }
  return Math.max(0, needed);
}

function getEquipFeedExpForItem(equip) {
  if (!equip) return 0;
  return getEquipEnchantFeedExp(equip.itemEquipId, equip.enchantLevel);
}

function getMiscEnchantExp(itemId) {
  const material = getEquipEnchantMaterials().find((entry) => Number(entry.itemId) === Number(itemId));
  return material ? Number(material.exp || 0) : 0;
}

function normalizeMiscItemList(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      itemId: Number(item && (item.itemId != null ? item.itemId : item.m_ItemMiscID || item.ItemID || 0)) || 0,
      count: Math.max(0, Math.trunc(Number(item && (item.count != null ? item.count : item.Count || 0)) || 0)),
    }))
    .filter((item) => item.itemId > 0 && item.count > 0);
}

function spendMiscCosts(user, costs, options = {}) {
  const paid = [];
  for (const cost of mergeCosts(costs)) {
    const spent = spendMiscItem(user, cost.itemId, cost.count, { regDate: options.regDate });
    if (spent) paid.push(spent);
  }
  return paid;
}

function mergeCosts(costs) {
  const byItem = new Map();
  for (const cost of Array.isArray(costs) ? costs : []) {
    const itemId = Number(cost && cost.itemId);
    const count = Math.max(0, Math.trunc(Number(cost && cost.count) || 0));
    if (!Number.isInteger(itemId) || itemId <= 0 || count <= 0) continue;
    byItem.set(itemId, (byItem.get(itemId) || 0) + count);
  }
  return Array.from(byItem.entries()).map(([itemId, count]) => ({ itemId, count }));
}

function getPrecisionCosts(templet) {
  return [
    { itemId: CREDIT_ITEM_ID, count: Number(templet && templet.m_PrecisionReqResource) || 0 },
    { itemId: TUNING_MATERIAL_ITEM_ID, count: Number(templet && templet.m_PrecisionReqItem) || 0 },
  ];
}

function getRandomStatCosts(templet) {
  return [
    { itemId: CREDIT_ITEM_ID, count: Number(templet && templet.m_RandomStatReqResource) || 0 },
    { itemId: TUNING_MATERIAL_ITEM_ID, count: Number(templet && templet.m_RandomStatReqItem) || 0 },
  ];
}

function getRandomSetCosts(templet) {
  return [
    { itemId: CREDIT_ITEM_ID, count: Number(templet && templet.m_RandomSetReqResource) || 0 },
    { itemId: Number(templet && templet.m_RandomSetReqItemID) || 0, count: Number(templet && templet.m_RandomSetReqItemValue) || 0 },
  ];
}

function getUpgradeMiscCosts(upgrade) {
  const costs = [{ itemId: CREDIT_ITEM_ID, count: Number(upgrade && upgrade.UpgradeReqResource) || 0 }];
  for (let index = 1; index <= 10; index += 1) {
    if (String(upgrade && upgrade[`Material${index}_ItemType`] || "") !== "RT_MISC") continue;
    costs.push({
      itemId: Number(upgrade[`Material${index}_ItemID`] || 0),
      count: Number(upgrade[`Material${index}_ItemCount`] || 0),
    });
  }
  return costs;
}

function removeUpgradeEquipMaterials(user, upgrade, consumeEquipUids = []) {
  const wanted = [];
  for (let index = 1; index <= 10; index += 1) {
    if (String(upgrade && upgrade[`Material${index}_ItemType`] || "") !== "RT_EQUIP") continue;
    const equipId = Number(upgrade[`Material${index}_ItemID`] || 0);
    const count = Math.max(1, Number(upgrade[`Material${index}_ItemCount`] || 1));
    for (let i = 0; i < count; i += 1) wanted.push(equipId);
  }
  const selected = [];
  const requested = Array.isArray(consumeEquipUids) ? consumeEquipUids.map((uid) => String(toBigInt(uid))) : [];
  for (const equipId of wanted) {
    const match =
      requested.find((uid) => {
        const equip = getEquipItem(user, uid);
        return equip && Number(equip.itemEquipId) === equipId && !selected.includes(uid);
      }) ||
      getEquipItems(user)
        .filter((equip) => Number(equip.itemEquipId) === equipId && String(equip.ownerUnitUid) === "-1" && !equip.locked)
        .map((equip) => equip.equipUid)
        .find((uid) => !selected.includes(uid));
    if (match) selected.push(match);
  }
  return removeEquipItems(user, selected);
}

function migrateStatsForNewTemplet(previousStats, templet, equip = null) {
  const stats = [defaultMainStat(templet, {})];
  const substats = normalizeStats(previousStats).slice(1, 3);
  for (let index = 0; index < 2; index += 1) {
    const previous = substats[index];
    const groupId = index === 0 ? templet.m_StatGroupID : templet.m_StatGroupID_2;
    if (Number(groupId || 0) <= 0) continue;
    stats.push(statForType(previous && previous.type, groupId, null, getPrecisionForSlot(equip, index + 1)) || rollFallbackStat(index + 1));
  }
  return normalizeEquipStats(stats, templet);
}

function updateStatValueForPrecision(equip, slot) {
  const templet = getEquipTemplet(equip.itemEquipId) || {};
  equip.stats = normalizeEquipStats(equip.stats, templet);
  const groupId = slot === 2 ? templet.m_StatGroupID_2 : templet.m_StatGroupID;
  if (Number(groupId || 0) <= 0 || slot >= equip.stats.length) return;
  const current = equip.stats[slot];
  const next = statForType(current && current.type, groupId, null, getPrecisionForSlot(equip, slot));
  if (next) equip.stats[slot] = next;
}

function getSocketOpenCosts(templet, socketIndex) {
  const index = Math.max(0, Math.min(2, Number(socketIndex || 0)));
  const costs = [];
  const resource = Number(templet && templet[`Socket${index + 1}_ReqResource`] || 0);
  const itemId = Number(templet && templet[`Socket${index + 1}_OpenItemID`] || 0);
  const itemCount = Number(templet && templet[`Socket${index + 1}_OpenCount`] || 0);
  if (resource > 0) costs.push({ itemId: CREDIT_ITEM_ID, count: resource });
  if (itemId > 0 && itemCount > 0) costs.push({ itemId, count: itemCount });
  return costs;
}

function getPotentialRerollCosts(templet, equip, _socketIndex) {
  const changeCount = ((equip.potentialOptions || [])[0] || {}).precisionChangeCount || 0;
  const base = Number(templet && templet.m_RelicRerollReqResource) || 0;
  const factor = Number(templet && templet.m_RelicRerollReqResourceFactor) || 0;
  const countFactor = getRelicRerollCountFactor();
  const multiplier = changeCount > 0 && factor > 0
    ? Math.round(factor * Math.pow(changeCount, countFactor) * 100) / 100
    : 1;
  const credit = changeCount > 0 ? Math.trunc(base * multiplier) : base;
  return [
    { itemId: CREDIT_ITEM_ID, count: credit },
    { itemId: Number(templet && templet.m_RelicRerollReqItemID) || 0, count: Number(templet && templet.m_RelicRerollReqItemValue) || 0 },
  ];
}

function pickPotentialOptionRecord(templet, equip, socketIndex, cursor = 0, precision = 100) {
  const groupId = Number((templet && (templet.potentialOptionGroupId || templet.m_PotentialOptionGroupID)) || 0);
  const allRecords = getEquipPotentialOptionRecords(groupId);
  if (!allRecords.length) return null;

  // Get the existing stat type from the equipment's potential options
  const existingStatType = (equip.potentialOptions && equip.potentialOptions[0] && equip.potentialOptions[0].statType) || null;

  // Filter records to only those matching the existing stat type (if one exists)
  const records = existingStatType
    ? allRecords.filter(record => normalizeRecordStatType(record, 1) === existingStatType)
    : allRecords;

  // If filtering resulted in no matches, fall back to all records
  const finalRecords = records.length > 0 ? records : allRecords;

  const record = finalRecords[Math.abs(Number(cursor) || 0) % finalRecords.length];
  const socket = Math.max(1, Math.min(3, Number(socketIndex || 0) + 1));
  const min = Number(record[`Socket${socket}_MinStat`] != null ? record[`Socket${socket}_MinStat`] : record[`Socket${socket}_MinStatRate`] || 0);
  const max = Number(record[`Socket${socket}_MaxStat`] != null ? record[`Socket${socket}_MaxStat`] : record[`Socket${socket}_MaxStatRate`] != null ? record[`Socket${socket}_MaxStatRate`] : min || 0);

  // Use the existing stat type if available, otherwise normalize the record's stat type
  const statType = existingStatType || normalizeRecordStatType(record, socket);

  return {
    precisionWeightId: Number(record.PrecisionWeightId || record.FirstPrecisionWeightId || 0),
    optionKey: Number(record.OptionKey || 0),
    statType,
    statValue: calcSubstatValue(statType, min, max, precision),
  };
}

function getMoldMaterialCosts(moldTemplet, count = 1) {
  const costs = [];
  const multiplier = normalizeCraftCount(count);
  for (let index = 1; index <= 4; index += 1) {
    const type = normalizeRewardType(moldTemplet && moldTemplet[`m_MaterialType${index}`]);
    if (!type) continue;
    costs.push({
      type,
      itemId: Number(moldTemplet[`m_MaterialID${index}`] || 0),
      count: Number(moldTemplet[`m_MaterialValue${index}`] || 0) * multiplier,
    });
  }
  return costs;
}

function createMoldReward(user, moldId, count = 1, options = {}) {
  const reward = createEmptyEquipReward();
  const moldTemplet = getEquipMoldTemplet(moldId);
  const rewardGroupId = Number(moldTemplet && moldTemplet.m_RewardGroupID) || 0;
  const records = getMoldRewardRecords(rewardGroupId);
  const craftCount = normalizeCraftCount(count);
  for (let index = 0; index < craftCount; index += 1) {
    const cursor = nextMoldRewardCursor(user, rewardGroupId);
    const record = pickMoldRewardRecord(records, cursor);
    const type = normalizeRewardType(record && record.m_RewardType);
    const id = Number(record && record.m_RewardID || 0);
    const rewardCount = Math.max(1, Number(record && (record.m_RewardValue || record.m_Quantity_Min || record.m_FreeQuantity_Min || 1)) || 1);
    if (type === "RT_EQUIP" && id > 0) {
      const equip = grantEquipItem(user, id, { cursor, regDate: options.regDate });
      if (equip) reward.equips.push(equip);
    } else if (type === "RT_MISC" && id > 0) {
      const item = grantMiscItem(user, id, BigInt(rewardCount), 0n, { regDate: options.regDate });
      if (item) reward.miscItems.push(item);
    } else if (type === "RT_MOLD" && id > 0) {
      const mold = grantMoldItem(user, id, rewardCount);
      if (mold) reward.moldItems.push(mold);
    } else {
      const equip = grantEquipItem(user, 0, { cursor, regDate: options.regDate });
      if (equip) reward.equips.push(equip);
    }
  }
  return reward;
}

function createEmptyEquipReward() {
  return { miscItems: [], skinIds: [], emoticonIds: [], units: [], operators: [], equips: [], moldItems: [], interiors: [] };
}

function craftResult(result = {}) {
  return {
    errorCode: CRAFT_ERROR.OK,
    slot: null,
    costItems: [],
    reward: createEmptyEquipReward(),
    extraCostItem: null,
    ...result,
  };
}

function normalizeCraftCount(count) {
  return Math.max(1, Math.trunc(Number(count) || 1));
}

function maxCraftStartCount(moldTemplet) {
  return EQUIP_CRAFT_TABS.has(String(moldTemplet && moldTemplet.m_MoldTabID || "")) ? MAX_EQUIP_CRAFT_COUNT : MAX_MATERIAL_CRAFT_COUNT;
}

function getCraftMaterialErrorCode(user, costs) {
  for (const cost of Array.isArray(costs) ? costs : []) {
    const itemId = Number(cost && cost.itemId || 0);
    const count = Math.max(0, Math.trunc(Number(cost && cost.count || 0) || 0));
    if (itemId <= 0 || count <= 0) continue;
    if (normalizeRewardType(cost.type) !== "RT_MISC") return CRAFT_ERROR.INSUFFICIENT_ITEM;
    if (!hasMiscItemCount(user, itemId, count)) {
      return itemId === CREDIT_ITEM_ID || itemId === CRAFT_SLOT_UNLOCK_ITEM_ID
        ? CRAFT_ERROR.INSUFFICIENT_RESOURCE
        : CRAFT_ERROR.INSUFFICIENT_ITEM;
    }
  }
  return CRAFT_ERROR.OK;
}

function hasMiscItemCount(user, itemId, count) {
  const item = getMiscItem(user, itemId);
  const total = toBigInt(item && item.countFree, 0n) + toBigInt(item && item.countPaid, 0n);
  return total >= BigInt(Math.max(0, Math.trunc(Number(count) || 0)));
}

function getCraftSlotState(slot, nowTicks) {
  if (!slot || Number(slot.moldId || 0) <= 0) return "empty";
  return toBigInt(nowTicks, 0n) >= toBigInt(slot.completeDate, 0n) ? "completed" : "creating";
}

function getExistingCraftSlot(user, slotIndex) {
  const craft = ensureCraftData(user);
  const index = normalizeCraftSlotIndex(slotIndex);
  if (!index) return null;
  return craft.slots[String(index)] ? normalizeCraftSlot(craft.slots[String(index)], index) : null;
}

function ensureCraftSlot(user, slotIndex) {
  const craft = ensureCraftData(user);
  const index = normalizeCraftSlotIndex(slotIndex) || 1;
  if (!craft.slots[String(index)]) craft.slots[String(index)] = createEmptyCraftSlot(index);
  return craft.slots[String(index)];
}

function normalizeCraftSlotIndex(slotIndex) {
  const numeric = Math.trunc(Number(slotIndex || 0));
  return Number.isInteger(numeric) && numeric >= 1 && numeric <= MAX_CRAFT_SLOTS ? numeric : 0;
}

function nextMoldRewardCursor(user, rewardGroupId) {
  if (!user || typeof user !== "object") return 0;
  user.craft = user.craft && typeof user.craft === "object" ? user.craft : {};
  user.craft.rewardCursors = user.craft.rewardCursors && typeof user.craft.rewardCursors === "object" ? user.craft.rewardCursors : {};
  const key = String(rewardGroupId || "default");
  const cursor = Math.max(0, Math.trunc(Number(user.craft.rewardCursors[key] || 0) || 0));
  user.craft.rewardCursors[key] = cursor + 1;
  return cursor;
}

function pickMoldRewardRecord(records, cursor = 0) {
  const list = Array.isArray(records) ? records.filter(Boolean) : [];
  if (!list.length) return null;
  const totalWeight = list.reduce((sum, record) => sum + Math.max(0, Number(record.m_Ratio || 1)), 0);
  if (totalWeight <= 0) return list[Math.abs(Number(cursor) || 0) % list.length];
  let target = Math.abs(Number(cursor) || 0) % totalWeight;
  for (const record of list) {
    target -= Math.max(0, Number(record.m_Ratio || 1));
    if (target < 0) return record;
  }
  return list[0];
}

function normalizeRewardType(type) {
  const text = String(type || "").trim();
  if (text === "RT_ITEM_MISC" || text === "RT_RESOURCE") return "RT_MISC";
  if (text === "RT_ITEM_EQUIP" || text === "RT_EQUIP_ITEM") return "RT_EQUIP";
  return text;
}

function createEmptyCraftSlot(index) {
  return { index: Number(index) || 1, moldId: 0, count: 0, completeDate: "0" };
}

function normalizeMoldItem(value, fallbackMoldId = 0) {
  if (!value || typeof value !== "object") return null;
  const moldId = Number(value.moldId != null ? value.moldId : value.m_MoldID != null ? value.m_MoldID : fallbackMoldId);
  if (!Number.isInteger(moldId) || moldId <= 0) return null;
  return { moldId, count: toBigInt(value.count != null ? value.count : value.m_Count || 0).toString() };
}

function normalizeCraftSlot(value, fallbackIndex = 1) {
  if (!value || typeof value !== "object") return null;
  return {
    index: Math.max(1, Math.min(MAX_CRAFT_SLOTS, Number(value.index != null ? value.index : value.Index != null ? value.Index : fallbackIndex) || 1)),
    moldId: Number(value.moldId != null ? value.moldId : value.MoldID || 0) || 0,
    count: Math.max(0, Number(value.count != null ? value.count : value.Count || 0) || 0),
    completeDate: String(toBigInt(value.completeDate != null ? value.completeDate : value.CompleteDate || 0)),
  };
}

function dateTimeTicksNow(value) {
  if (value != null) {
    const raw = toBigInt(value, 0n);
    if (raw > 0n) return raw > DATE_TIME_LOCAL_MASK ? raw & DATE_TIME_TICKS_MASK : raw;
  }
  return BigInt(Date.now()) * 10000n + TICKS_AT_UNIX_EPOCH;
}

function normalizeEquip(value) {
  if (!value || typeof value !== "object") return null;
  const equipUid = toBigInt(value.equipUid != null ? value.equipUid : value.m_ItemUid || 0);
  const itemEquipId = Number(value.itemEquipId != null ? value.itemEquipId : value.m_ItemEquipID || 0);
  if (equipUid <= 0n || !Number.isInteger(itemEquipId) || itemEquipId <= 0) return null;
  const templet = getEquipTemplet(itemEquipId) || {};
  return {
    ...value,
    equipUid: equipUid.toString(),
    itemEquipId,
    ownerUnitUid: String(toBigInt(value.ownerUnitUid != null ? value.ownerUnitUid : value.m_OwnerUnitUID != null ? value.m_OwnerUnitUID : -1)),
    enchantLevel: Number(value.enchantLevel != null ? value.enchantLevel : value.m_EnchantLevel || 0) || 0,
    enchantExp: Number(value.enchantExp != null ? value.enchantExp : value.m_EnchantExp || 0) || 0,
    stats: normalizeEquipStats(value.stats || value.m_Stat, templet),
    locked: Boolean(value.locked || value.m_bLock),
    precision: Number(value.precision != null ? value.precision : value.m_Precision || 0) || 0,
    precision2: Number(value.precision2 != null ? value.precision2 : value.m_Precision2 || 0) || 0,
    setOptionId: Number(value.setOptionId != null ? value.setOptionId : value.m_SetOptionId || 0) || 0,
    imprintUnitId: Number(value.imprintUnitId != null ? value.imprintUnitId : value.m_ImprintUnitId || 0) || 0,
    potentialOptions: Array.isArray(value.potentialOptions) ? value.potentialOptions : [],
    regDate: String(value.regDate || "0"),
  };
}

function normalizeStats(stats, targetLength = 3) {
  const length = Math.max(1, Math.min(3, Math.trunc(Number(targetLength) || 3)));
  const list = Array.isArray(stats) ? stats.slice(0, length) : [];
  const result = list.map((stat, index) => ({
    type: String((stat && (stat.type || stat.statType)) || (index === 0 ? "NST_HP" : DEFAULT_STAT_TYPES[index] || "NST_ATK")),
    value: Number(stat && (stat.value != null ? stat.value : stat.stat_value || 0)) || 0,
    levelValue: Number(stat && (stat.levelValue != null ? stat.levelValue : stat.stat_level_value || 0)) || 0,
  }));
  while (result.length < length) result.push(rollFallbackStat(result.length));
  return result;
}

function normalizeEquipStats(stats, templet) {
  return normalizeStats(stats, expectedStatCountForTemplet(templet));
}

function expectedStatCountForTemplet(templet) {
  let count = 1;
  if (Number(templet && templet.m_StatGroupID || 0) > 0) count += 1;
  if (Number(templet && templet.m_StatGroupID_2 || 0) > 0) count += 1;
  return count;
}

function rollStatFromGroup(groupId, cursor = 0, precision = 100, exceptStatType = null) {
  const normalizedExcept = normalizeStatType(exceptStatType);
  const allRecords = getEquipRandomStatRecords(groupId);
  const records = normalizedExcept && allRecords.length > 1
    ? allRecords.filter((record) => normalizeStatType(record && record.m_StatType) !== normalizedExcept)
    : allRecords;
  if (!records.length) return null;
  const record = records[Math.abs(Number(cursor) || 0) % records.length];
  return statForType(record.m_StatType, groupId, record, precision);
}

function defaultMainStat(templet, options = {}) {
  return {
    type: templet.STAT_TYPE_1 || options.statType || "NST_HP",
    value: Number(templet.STAT_VALUE_1 || options.statValue || 0),
    levelValue: Number(templet.STAT_LEVELUP_VALUE_1 || options.statLevelValue || 0),
  };
}

function buildCustomMainStat(templet, mainStat) {
  const defaultStatType = normalizeStatType(templet && templet.STAT_TYPE_1) || "NST_HP";
  const usesDefaultType = isDefaultMainStatType(mainStat && mainStat.type);
  const statType = usesDefaultType ? defaultStatType : normalizeStatType(mainStat && mainStat.type) || defaultStatType;
  const templetMatches = usesDefaultType || normalizeStatType(templet && templet.STAT_TYPE_1) === statType;
  const valueFallback = templetMatches
    ? finiteNumber(templet && templet.STAT_VALUE_1, maxMainStatValueForType(statType))
    : maxMainStatValueForType(statType);
  const levelFallback = templetMatches
    ? finiteNumber(templet && templet.STAT_LEVELUP_VALUE_1, maxMainStatLevelValueForType(statType))
    : maxMainStatLevelValueForType(statType);
  return {
    type: statType,
    value: mainStat && mainStat.valueKind === "max" ? valueFallback : finiteNumber(mainStat && mainStat.value, valueFallback),
    levelValue:
      mainStat && (mainStat.levelValueKind === "max" || mainStat.levelValue == null)
        ? levelFallback
        : finiteNumber(mainStat && mainStat.levelValue, levelFallback),
  };
}

function statForType(statType, groupId = 0, record = null, precision = 100) {
  const normalized = normalizeStatType(statType);
  const data = record || findStatRecord(groupId, normalized) || {};
  const min = getRecordMinStatValue(data);
  const max = getRecordMaxStatValue(data, min);
  return {
    type: normalized || "NST_HP",
    value: calcSubstatValue(normalized || "NST_HP", min, max, precision),
    levelValue: 0,
  };
}

function normalizeCustomMainStat(mainStat) {
  if (!mainStat || typeof mainStat !== "object") return null;
  const type = isDefaultMainStatType(mainStat.type) ? "DEFAULT" : normalizeStatType(mainStat.type);
  if (!type) return null;
  const normalized = {
    type,
    value: mainStat.valueKind === "max" ? null : finiteNumber(mainStat.value, 0),
    valueKind: mainStat.valueKind === "max" ? "max" : "custom",
  };
  if (mainStat.levelValueKind === "max") {
    normalized.levelValueKind = "max";
    normalized.levelValue = null;
  } else if (mainStat.levelValue != null) {
    normalized.levelValueKind = "custom";
    normalized.levelValue = finiteNumber(mainStat.levelValue, 0);
  }
  return normalized;
}

function isDefaultMainStatType(value) {
  return ["DEFAULT", "NATIVE", "ORIGINAL"].includes(String(value || "").trim().toUpperCase());
}

function buildCustomSubstat(groupId, substat, options = {}) {
  const statType = normalizeStatType(substat && substat.type);
  const record = findStatRecord(groupId, statType);
  if (!record && options.overrideUnsupportedSubstats !== true) return null;
  const value = substat && substat.valueKind === "max"
    ? maxStatValueForType(statType, record)
    : finiteNumber(substat && substat.value, statForType(statType, groupId, record, options.precision).value);
  return {
    type: statType,
    value,
    levelValue: finiteNumber(substat && substat.levelValue, 0),
  };
}

function normalizeCustomSubstats(substats) {
  const list = Array.isArray(substats) ? substats : [];
  return list
    .map((substat, index) => {
      const type = normalizeStatType(substat && substat.type);
      if (!type) return null;
      return {
        slot: normalizeSubstatSlot(substat.slot != null ? substat.slot : index + 1),
        type,
        value: substat && substat.valueKind === "max" ? null : finiteNumber(substat && substat.value, 0),
        valueKind: substat && substat.valueKind === "max" ? "max" : "custom",
        levelValue: finiteNumber(substat && substat.levelValue, 0),
      };
    })
    .filter(Boolean)
    .slice(0, 2);
}

function normalizeStatType(statType) {
  if (typeof statType === "number" || /^-?\d+$/.test(String(statType || "").trim())) {
    const name = statTypeName(statType);
    if (name) return name;
  }
  const text = String(statType || "").trim().toUpperCase();
  if (!text) return "";
  return text.startsWith("NST_") ? text : `NST_${text}`;
}

function emptyTuningCandidate() {
  return { equipUid: "0", option1: "NST_RANDOM", option2: "NST_RANDOM", setOptionId: 0 };
}

function ensureEquipResetCounts(user) {
  user.equipResetCounts = user.equipResetCounts && typeof user.equipResetCounts === "object" ? user.equipResetCounts : {};
  return user.equipResetCounts;
}

function getEquipResetCount(user, groupId) {
  const counts = ensureEquipResetCounts(user);
  const value = Number(counts[String(groupId)] || 0);
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function setEquipResetCount(user, groupId, count) {
  const normalized = Math.max(0, Math.trunc(Number(count) || 0));
  ensureEquipResetCounts(user)[String(groupId)] = normalized;
  return { groupId: Number(groupId) || 0, count: normalized };
}

function incrementEquipResetCount(user, groupId, maxCount) {
  const next = Math.min(Math.max(0, Number(maxCount) || 0), getEquipResetCount(user, groupId) + 1);
  return setEquipResetCount(user, groupId, next);
}

function normalizeSubstatSlot(slot) {
  return Number(slot) === 2 ? 2 : 1;
}

function findStatRecord(groupId, statType) {
  const normalized = normalizeStatType(statType);
  return getEquipRandomStatRecords(groupId).find((record) => normalizeStatType(record && record.m_StatType) === normalized) || null;
}

function maxStatValueForType(statType, preferredRecord = null) {
  const direct = statMaxValue(preferredRecord);
  if (direct != null) return direct;
  const normalized = normalizeStatType(statType);
  const records = getAllEquipRandomStatRecords().filter((record) => normalizeStatType(record && record.m_StatType) === normalized);
  const values = records.map(statMaxValue).filter((value) => value != null);
  if (values.length) return Math.max(...values);
  return normalized.includes("RATE") ? 0.1 : 100;
}

function maxMainStatValueForType(statType) {
  return maxMainStatFieldForType(statType, "STAT_VALUE_1");
}

function maxMainStatLevelValueForType(statType) {
  return maxMainStatFieldForType(statType, "STAT_LEVELUP_VALUE_1");
}

function maxMainStatFieldForType(statType, fieldName) {
  const normalized = normalizeStatType(statType);
  const values = getAllEquipIds()
    .map((equipId) => getEquipTemplet(equipId))
    .filter((record) => normalizeStatType(record && record.STAT_TYPE_1) === normalized)
    .map((record) => Number(record && record[fieldName]))
    .filter((value) => Number.isFinite(value));
  if (values.length) return Math.max(...values);
  return normalized.includes("RATE") ? 0.1 : 100;
}

function statMaxValue(record) {
  if (!record) return null;
  const value = getRecordMaxStatValue(record, null);
  return Number.isFinite(value) ? value : null;
}

function getRecordMinStatValue(record) {
  const value = Number(record && (record.m_MinStatValue != null ? record.m_MinStatValue : record.m_MinStat != null ? record.m_MinStat : 0.01));
  return Number.isFinite(value) ? value : 0.01;
}

function getRecordMaxStatValue(record, fallback = 0.01) {
  const value = Number(record && (record.m_MaxStatValue != null ? record.m_MaxStatValue : record.m_MaxStat != null ? record.m_MaxStat : fallback));
  return Number.isFinite(value) ? value : fallback;
}

function calcSubstatValue(statType, min, max, precision) {
  const normalizedPrecision = normalizePrecision(precision);
  const ratio = normalizedPrecision / 100;
  const minValue = Number.isFinite(Number(min)) ? Number(min) : 0;
  const maxValue = Number.isFinite(Number(max)) ? Number(max) : minValue;
  const raw = maxValue < 0 && minValue < 0
    ? (minValue - maxValue) * ratio + maxValue
    : (maxValue - minValue) * ratio + minValue;

  // Detect fractional stats by BOTH stat type name AND value range
  const isPercentByName = isPercentStatType(statType);
  const isPercentByValue = Math.abs(minValue) < 1 && Math.abs(maxValue) < 1;
  const isPercent = isPercentByName || isPercentByValue;

  const result = isPercent ? Math.trunc(raw * 10000) / 10000 : Math.trunc(raw);

  return result;
}

function isPercentStatType(statType) {
  const normalized = normalizeStatType(statType);
  // Check for common percentage/fractional stat indicators
  return normalized.includes("RATE") ||
         normalized.includes("FACTOR") ||
         normalized.includes("MODIFY");
}

function factorStatType(statType) {
  return {
    NST_HP: "NST_HP_FACTOR",
    NST_ATK: "NST_ATK_FACTOR",
    NST_DEF: "NST_DEF_FACTOR",
    NST_CRITICAL: "NST_CRITICAL_FACTOR",
    NST_HIT: "NST_HIT_FACTOR",
    NST_EVADE: "NST_EVADE_FACTOR",
  }[statType] || "";
}

function normalizeRecordStatType(record, socketNumber) {
  const statType = record.Socket1_StatType || "NST_HP";
  // Check if this socket uses Rate fields instead of Stat fields
  const usesRateFields =
    record[`Socket${socketNumber}_MinStatRate`] != null ||
    record[`Socket${socketNumber}_MaxStatRate`] != null;

  const transformed = usesRateFields ? (factorStatType(statType) || statType) : statType;

  return transformed;
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function rollFallbackStat(cursor = 0) {
  const type = DEFAULT_STAT_TYPES[Math.abs(Number(cursor) || 0) % DEFAULT_STAT_TYPES.length];
  return { type, value: type.includes("RATE") ? 0.05 : 50, levelValue: 0 };
}

function pickSetOptionId(templet, cursor = 0, exceptSetOptionId = 0) {
  const ids = getEquipSetOptionIds(templet);
  if (!ids.length) return 0;
  const filtered = ids.length > 1 ? ids.filter((id) => Number(id) !== Number(exceptSetOptionId || 0)) : ids;
  return filtered[Math.abs(Number(cursor) || 0) % filtered.length];
}

function buildDefaultPotentialOptions(templet) {
  if (!templet || templet.m_bRelic !== true) return [];
  return [buildDefaultPotentialOption({ itemEquipId: templet.m_ItemEquipID })];
}

function buildDefaultPotentialOption(equip) {
  const templet = getEquipTemplet(equip.itemEquipId) || {};
  const groupId = Number(templet.m_PotentialOptionGroupID || 0);
  // Get stat type from potential option table, not from equipment substats
  let statType = "NST_HP";
  let chosenOptionKey = 0;
  if (groupId > 0) {
    const records = getEquipPotentialOptionRecords(groupId);
    if (records.length > 0) {
      // Try to find a record with a valid Socket1_StatType
      const recordsWithStatType = records.filter(r => r.Socket1_StatType);
      const recordsToUse = recordsWithStatType.length > 0 ? recordsWithStatType : records;
      const index = hashPrecisionSeed(equip.itemEquipId, equip.equipUid || 0, "potential-default") % recordsToUse.length;
      const record = recordsToUse[index];
      // Transform the stat type based on whether it uses Rate fields (check socket 1)
      statType = normalizeRecordStatType(record, 1);
      chosenOptionKey = Number(record.OptionKey || 0);
    }
  }
  return {
    optionKey: chosenOptionKey,
    statType,
    sockets: [null, null, null],
    precisionChangeCount: 0,
  };
}

function getPotentialSocketPrecision(equip, socketIndex) {
  const option = (Array.isArray(equip && equip.potentialOptions) ? equip.potentialOptions : [])[0] || {};
  const sockets = Array.isArray(option.sockets) ? option.sockets : [];
  const index = Math.max(0, Math.min(2, Number(socketIndex || 0)));
  const precision = normalizePrecision(sockets[index] && sockets[index].precision);

  return precision;
}

function inferEquipPosition(equip) {
  const templet = getEquipTemplet(equip && equip.itemEquipId) || {};
  return EQUIP_POSITION_INDEX[String(templet.m_ItemEquipPosition || "")] != null
    ? EQUIP_POSITION_INDEX[String(templet.m_ItemEquipPosition || "")]
    : 0;
}

function normalizePosition(position, fallback = 0) {
  const numeric = Number(position);
  const fallbackNumeric = Number(fallback);
  const safeFallback = Number.isInteger(fallbackNumeric) && fallbackNumeric >= 0 && fallbackNumeric <= 3 ? fallbackNumeric : 0;
  return Number.isInteger(numeric) && numeric >= 0 && numeric <= 3 ? numeric : safeFallback;
}

function normalizeOptionSlot(optionId) {
  const numeric = Number(optionId);
  if (numeric === 2) return 2;
  return 1;
}

function normalizePrecision(value) {
  const numeric = Math.trunc(Number(value));
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, numeric));
}

function getPrecisionForSlot(equip, slot) {
  return normalizePrecision(slot === 2 ? equip && equip.precision2 : equip && equip.precision);
}

function getStatGroupIdForSlot(equip, slot) {
  const templet = getEquipTemplet(equip && equip.itemEquipId) || {};
  return slot === 2 ? templet.m_StatGroupID_2 : templet.m_StatGroupID;
}

function rollInitialPrecision(templet, slot, options = {}) {
  const groupId = slot === 2 ? templet.m_StatGroupID_2 : templet.m_StatGroupID;
  const records = getEquipRandomStatRecords(groupId);
  if (!records.length) return 0;
  if (records.every((record) => getRecordMinStatValue(record) === getRecordMaxStatValue(record, getRecordMinStatValue(record)))) {
    return 100;
  }
  const seed = hashPrecisionSeed(templet.m_ItemEquipID, options.equipUid, slot, options.cursor);
  return 20 + (seed % 71);
}

function rollPrecisionOutcome(user, equip, slot, currentPrecision = 0) {
  const cursor = Number(user.localEquipPrecisionCursor || 0);
  user.localEquipPrecisionCursor = cursor + 1;
  const current = normalizePrecision(currentPrecision);
  const precision = rollIncreasingPrecisionFromTable(DEFAULT_PRECISION_WEIGHT_ID, current, equip && equip.equipUid, equip && equip.itemEquipId, slot, cursor);
  return {
    refineResult: getPrecisionRefineResult(current, precision),
    precision,
  };
}

function rollIncreasingPrecisionFromTable(weightId, currentPrecision, ...seedParts) {
  const current = normalizePrecision(currentPrecision);
  const candidates = getPrecisionWeightCandidates(weightId)
    .filter((entry) => entry.precision > current);
  if (!candidates.length) return current >= 100 ? 100 : normalizePrecision(current + 1);
  const totalWeight = candidates.reduce((total, entry) => total + entry.weight, 0);
  if (totalWeight <= 0) return candidates[candidates.length - 1].precision;
  let roll = hashPrecisionSeed(weightId, current, ...seedParts) % totalWeight;
  for (const entry of candidates) {
    if (roll < entry.weight) return entry.precision;
    roll -= entry.weight;
  }
  return candidates[candidates.length - 1].precision;
}

function getPrecisionWeightCandidates(weightId) {
  return getEquipPrecisionWeightRecords(weightId)
    .map((record) => ({
      precision: normalizePrecision(record && record.Precision),
      weight: Math.max(0, Math.trunc(Number(record && record.Weight) || 0)),
    }))
    .filter((entry) => entry.weight > 0)
    .sort((a, b) => a.precision - b.precision);
}

function getPrecisionRefineResult(currentPrecision, nextPrecision) {
  const delta = normalizePrecision(nextPrecision) - normalizePrecision(currentPrecision);
  return delta >= 10 ? 1 : 0;
}

function hashPrecisionSeed(...parts) {
  let hash = 2166136261;
  for (const part of parts) {
    const text = String(part == null ? "" : part);
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
  }
  return hash >>> 0;
}

function getUnitByUid(army, unitUid) {
  const key = String(toBigInt(unitUid));
  return army.units[key] || army.ships[key] || null;
}

function findEquipOwnerUnit(army, equipUid) {
  const key = String(toBigInt(equipUid));
  for (const unit of [...Object.values(army.units || {}), ...Object.values(army.ships || {})]) {
    if (!unit || !Array.isArray(unit.equipItemUids)) continue;
    const position = unit.equipItemUids.findIndex((uid) => String(toBigInt(uid)) === key);
    if (position >= 0) return { unit, position };
  }
  return null;
}

function unequipFromAnyUnit(army, equipUid) {
  const key = String(toBigInt(equipUid));
  for (const unit of [...Object.values(army.units || {}), ...Object.values(army.ships || {})]) {
    if (!unit || !Array.isArray(unit.equipItemUids)) continue;
    unit.equipItemUids = unit.equipItemUids.map((uid) => (String(toBigInt(uid)) === key ? 0 : uid));
  }
}

function reconcileEquipOwnership(user, inventory) {
  if (!user || typeof user !== "object" || !inventory || typeof inventory !== "object") return false;
  const equips = inventory.equips && typeof inventory.equips === "object" ? inventory.equips : {};
  const army = ensureArmy(user);
  const ownerByEquipUid = new Map();
  const seenEquips = new Set();
  let changed = false;

  const visitUnit = (unit, fallbackUnitUid) => {
    if (!unit || typeof unit !== "object") return;
    const unitUid = String(toBigInt(unit.unitUid != null ? unit.unitUid : fallbackUnitUid || 0));
    const previousSlots = Array.isArray(unit.equipItemUids) ? unit.equipItemUids : [];
    const slots = normalizeFixedArray(unit.equipItemUids, 4, 0);
    for (let index = 0; index < slots.length; index += 1) {
      const key = String(toBigInt(slots[index] || 0));
      const isValid = key !== "0" && equips[key] && unitUid !== "0" && !seenEquips.has(key);
      const nextSlot = isValid ? key : 0;
      const previousKey = String(toBigInt(previousSlots[index] || 0));
      const nextKey = String(toBigInt(nextSlot || 0));
      if (previousKey !== nextKey) changed = true;
      slots[index] = nextSlot;
      if (!isValid) continue;
      seenEquips.add(key);
      ownerByEquipUid.set(key, unitUid);
    }
    if (!Array.isArray(unit.equipItemUids) || unit.equipItemUids.length !== 4) changed = true;
    unit.equipItemUids = slots;
  };

  for (const [unitUid, unit] of Object.entries(army.units || {})) visitUnit(unit, unitUid);
  for (const [unitUid, unit] of Object.entries(army.ships || {})) visitUnit(unit, unitUid);

  for (const [equipUid, equip] of Object.entries(equips)) {
    if (!equip || typeof equip !== "object") continue;
    const key = String(toBigInt(equip.equipUid != null ? equip.equipUid : equipUid));
    const ownerUnitUid = ownerByEquipUid.get(key) || "-1";
    if (String(toBigInt(equip.ownerUnitUid != null ? equip.ownerUnitUid : -1)) !== ownerUnitUid) changed = true;
    equip.ownerUnitUid = ownerUnitUid;
  }

  return changed;
}

function allocateEquipUid(user) {
  const inventory = ensureEquipInventory(user);
  let next = toBigInt(user.nextEquipUid, DEFAULT_NEXT_EQUIP_UID);
  while (inventory.equips[next.toString()]) next += 1n;
  user.nextEquipUid = String(next + 1n);
  return next;
}

function normalizeEquipPresets(inventory) {
  inventory.equipPresets = (Array.isArray(inventory.equipPresets) ? inventory.equipPresets : []).map((preset, index) => ({
    presetIndex: Number(preset && preset.presetIndex != null ? preset.presetIndex : index) || index,
    presetName: String((preset && (preset.presetName || preset.name)) || ""),
    equipUids: sanitizePresetEquipUids(inventory, preset && preset.equipUids),
  })).map((preset) => ({
    ...preset,
    presetType: inferEquipPresetType(inventory, preset.equipUids),
  }));
  if (!inventory.equipPresets.length) {
    inventory.equipPresets.push({ presetIndex: 0, presetType: EQUIP_PRESET_TYPE.NONE, presetName: "", equipUids: [0, 0, 0, 0] });
  }
  inventory.equipPresets.forEach((preset, index) => {
    preset.presetIndex = index;
  });
}

function sanitizePresetEquipUids(inventory, values) {
  const seen = new Set();
  return normalizeFixedArray(values, 4, 0).map((uid) => {
    const key = normalizePresetEquipUid(inventory, uid);
    if (key === 0 || seen.has(key)) return 0;
    seen.add(key);
    return key;
  });
}

function normalizePresetEquipUid(inventory, uid) {
  const key = String(toBigInt(uid || 0));
  return key !== "0" && inventory && inventory.equips && inventory.equips[key] ? key : 0;
}

function inferEquipPresetType(inventory, equipUids) {
  for (const uid of normalizeFixedArray(equipUids, 4, 0)) {
    const key = String(toBigInt(uid || 0));
    const equip = key !== "0" && inventory && inventory.equips ? inventory.equips[key] : null;
    if (!equip) continue;
    const templet = getEquipTemplet(equip.itemEquipId) || {};
    const presetType = EQUIP_PRESET_TYPE_BY_STYLE[String(templet.m_EquipUnitStyleType || "")];
    if (presetType) return presetType;
  }
  return EQUIP_PRESET_TYPE.NONE;
}

function buildUnitEquipUpdates(army, unitUids, preferredUnitUid = null, options = {}) {
  const ordered = [];
  const seen = new Set();
  const add = (uid) => {
    const key = String(toBigInt(uid || 0));
    if (key === "0" || seen.has(key)) return;
    const unit = getUnitByUid(army, key);
    if (!unit) return;
    seen.add(key);
    ordered.push({ unitUid: key, equipUids: normalizeFixedArray(unit.equipItemUids, 4, 0) });
  };
  if (!options.preferredLast) add(preferredUnitUid);
  for (const uid of unitUids || []) add(uid);
  if (options.preferredLast) add(preferredUnitUid);
  return ordered;
}

function markInventoryTouched(inventory) {
  if (inventory && typeof inventory === "object") inventory.localTouchedAt = new Date().toISOString();
}

function normalizeFixedArray(values, length, fallback) {
  const result = Array.isArray(values) ? values.slice(0, length) : [];
  while (result.length < length) result.push(fallback);
  return result;
}

module.exports = {
  ensureEquipInventory,
  getEquipItems,
  getEquipItem,
  ensureCraftData,
  getMoldItems,
  getCraftSlots,
  grantMoldItem,
  startCraft,
  completeCraft,
  instantCraft,
  instantCompleteCraft,
  unlockCraftSlot,
  grantEquipItem,
  createEquipData,
  validateEquipCustomSubstats,
  removeEquipItems,
  equipItemToUnit,
  unequipItem,
  lockEquipItem,
  enchantEquipItem,
  rollEquipPrecision,
  rollEquipSubstat,
  confirmEquipSubstat,
  cancelEquipTuning,
  rollSetOption,
  confirmSetOption,
  imprintEquip,
  upgradeEquipItem,
  openPotentialSocket,
  rollPotentialOption,
  confirmPotentialOption,
  getEquipPresets,
  addEquipPresets,
  ensureEquipPreset,
  setEquipPresetName,
  registerEquipPreset,
  registerEquipPresetFromUnit,
  applyEquipPreset,
  clearEquipPresets,
  changeEquipPresetIndices,
};
