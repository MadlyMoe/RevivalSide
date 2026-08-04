const { dateTimeBinaryNow, statTypeName, toBigInt } = require("../packet-codec");
const {
  getUnitTemplet,
  resolveUnitId,
  getPieceTemplet,
  getSkinTemplet,
  getUnitSkillIndex,
  getUnitSkillMaxLevel,
  getLimitBreakMaxLevel,
  getMaxLimitBreakRank,
  getShipMaxLevel,
  getUnitLevelByTotalExp,
  getTotalExpForUnitLevel,
  getOperatorTotalExpForLevel,
  getOperatorRequiredExpForLevel,
  getOperatorMaxLevel,
  getOperatorLevelByTotalExp,
} = require("../game-data");
const { grantSkin } = require("../inventory");

const DEFAULT_NEXT_UNIT_UID = 9000000000000001n;
const DEFAULT_NEW_UNIT_LOYALTY = 0;
const MAX_UNIT_LOYALTY = 10000;
const UNIT_LIMIT_BREAK_MAX_LEVEL = 120;
const DECK_TYPE_NORMAL = 1;
const DECK_TYPE_DAILY = 3;
const DECK_TYPE_RAID = 4;
const DECK_TYPE_DIVE = 8;
const DECK_TYPE_EXPLORE = 10;

function ensureArmy(user) {
  if (!user || typeof user !== "object") return { units: {}, ships: {}, trophies: {}, operators: {}, decks: [] };
  user.army = user.army && typeof user.army === "object" ? user.army : {};
  user.army.units = user.army.units && typeof user.army.units === "object" ? user.army.units : {};
  user.army.ships = user.army.ships && typeof user.army.ships === "object" ? user.army.ships : {};
  user.army.trophies = user.army.trophies && typeof user.army.trophies === "object" ? user.army.trophies : {};
  user.army.operators = user.army.operators && typeof user.army.operators === "object" ? user.army.operators : {};
  user.army.decks = Array.isArray(user.army.decks) ? user.army.decks : [];
  user.army.deckSets = user.army.deckSets && typeof user.army.deckSets === "object" ? user.army.deckSets : {};
  user.nextUnitUid = String(toBigInt(user.nextUnitUid, DEFAULT_NEXT_UNIT_UID));

  normalizeUnitMap(user.army.units);
  normalizeUnitMap(user.army.ships);
  normalizeUnitMap(user.army.trophies);
  normalizeArmyUnitBuckets(user.army);
  normalizeOperatorMap(user.army.operators);
  normalizeDeckSets(user.army);
  sanitizeDeckReferences(user.army);
  return user.army;
}

function getArmyUnits(user) {
  const army = ensureArmy(user);
  return Object.values(army.units)
    .map(normalizeUnit)
    .filter(Boolean)
    .filter(isSerializableArmyUnit)
    .sort((a, b) => Number(toBigInt(a.unitUid) - toBigInt(b.unitUid)));
}

function getArmyShips(user) {
  const army = ensureArmy(user);
  return Object.values(army.ships)
    .map(normalizeUnit)
    .filter(Boolean)
    .sort((a, b) => Number(toBigInt(a.unitUid) - toBigInt(b.unitUid)));
}

function getArmyTrophies(user) {
  const army = ensureArmy(user);
  return Object.values(army.trophies)
    .map(normalizeUnit)
    .filter(Boolean)
    .sort((a, b) => Number(toBigInt(a.unitUid) - toBigInt(b.unitUid)));
}

function getArmyOperators(user) {
  const army = ensureArmy(user);
  return Object.values(army.operators || {})
    .map(normalizeOperatorData)
    .filter((operator) => operator && Number(operator.id || operator.unitId) > 0)
    .sort((a, b) => Number(toBigInt(a.uid || a.operatorUid || 0) - toBigInt(b.uid || b.operatorUid || 0)));
}

function getArmyDeckSets(user) {
  const army = ensureArmy(user);
  const result = [];
  for (let deckType = 0; deckType <= 10; deckType += 1) {
    result.push({
      deckType,
      decks: getDeckSet(army, deckType).map((deck) => normalizeDeck(deck, deckType)),
    });
  }
  return result;
}

function ensureDefaultLineup(user, options = {}) {
  if (!user) return null;
  const availableUnits = getArmyUnits(user);
  const availableShips = getArmyShips(user);
  const availableOperators = getArmyOperators(user);
  const deckIndex = {
    deckType: Number(options.deckType != null ? options.deckType : DECK_TYPE_NORMAL),
    index: Number(options.index || 0),
  };
  const deck = ensureDeck(user, deckIndex);
  let hasUnits = deckHasUnitUids(deck);
  if (!hasUnits && (deckIndex.deckType === DECK_TYPE_DAILY || deckIndex.deckType === DECK_TYPE_RAID)) {
    const normalDeck = getDeckSet(user.army, DECK_TYPE_NORMAL)[deck.index];
    if (deckHasUnitUids(normalDeck)) {
      deck.unitUids = normalizeFixedArray(normalDeck.unitUids, deck.unitUids.length, 0);
      deck.shipUid = normalDeck.shipUid;
      deck.operatorUid = normalDeck.operatorUid;
      deck.leaderIndex = normalDeck.leaderIndex;
      hasUnits = true;
    }
  }
  if (!hasUnits) {
    const units = availableUnits.slice(0, deck.unitUids.length);
    for (let index = 0; index < units.length; index += 1) {
      deck.unitUids[index] = units[index].unitUid;
    }
  }
  if (toBigInt(deck.shipUid || 0) <= 0n) {
    const ship = availableShips[0];
    if (ship) deck.shipUid = ship.unitUid;
  }
  if (toBigInt(deck.operatorUid || 0) <= 0n) {
    const operator = availableOperators[0];
    if (operator) deck.operatorUid = String(toBigInt(operator.uid || operator.operatorUid || 0));
  }
  if (deck.leaderIndex < 0 || toBigInt(deck.unitUids[deck.leaderIndex] || 0) <= 0n) {
    deck.leaderIndex = deck.unitUids.findIndex((uid) => toBigInt(uid) > 0n);
  }
  return deck;
}

function buildPlayerDeckForGameLoad(user, req = {}, options = {}) {
  if (!user) return null;
  const deckIndex = resolveDeckIndexForGameLoad(user, req);
  ensureDefaultLineup(user, deckIndex);
  const army = ensureArmy(user);
  const deck = ensureDeck(user, deckIndex);
  const allowedUnitSlots = normalizeAllowedUnitSlots(options.allowedUnitSlots);
  const explicitSlotUnitUids = normalizeSlotUnitUidMap(options.slotUnitUids || options.eventDeckUnitUids);
  const unitSlotAssignments = buildDeckUnitSlotAssignments(deck, allowedUnitSlots, explicitSlotUnitUids);
  const units = [];
  let leaderUnitUid = "0";
  let leaderIndex = Number(options.leaderIndex != null ? options.leaderIndex : deck.leaderIndex);
  const hasExplicitLeaderIndex = Number.isInteger(leaderIndex) && leaderIndex >= 0;

  for (const assignment of unitSlotAssignments) {
    const slotIndex = assignment.slotIndex;
    const uid = toBigInt(assignment.unitUid || 0);
    if (uid <= 0n) continue;
    const unit = normalizeUnit(army.units[uid.toString()]);
    if (!unit || !isSerializableArmyUnit(unit)) continue;
    const serialized = buildPlayerDeckUnit(unit, slotIndex);
    units.push(serialized);
    if (slotIndex === leaderIndex) {
      leaderUnitUid = serialized.unitUid;
      leaderIndex = slotIndex;
    }
  }

  if (!units.length) return null;
  if (toBigInt(leaderUnitUid) <= 0n) {
    if (allowedUnitSlots && hasExplicitLeaderIndex) {
      leaderUnitUid = "0";
    } else {
      leaderUnitUid = units[0].unitUid;
      leaderIndex = units[0].slotIndex;
      if (!allowedUnitSlots) deck.leaderIndex = leaderIndex;
    }
  }

  const requestedShipUid = toBigInt(options.shipUid || 0) > 0n ? String(toBigInt(options.shipUid)) : deck.shipUid;
  const requestedOperatorUid =
    toBigInt(options.operatorUid || 0) > 0n ? String(toBigInt(options.operatorUid)) : deck.operatorUid;
  const ship = normalizeUnit(army.ships[String(toBigInt(requestedShipUid || 0))]) || getArmyShips(user)[0] || null;
  const operator =
    (army.operators && army.operators[String(toBigInt(requestedOperatorUid || 0))]) || getArmyOperators(user)[0] || null;

  if (ship && toBigInt(deck.shipUid || 0) <= 0n) deck.shipUid = ship.unitUid;
  if (operator && toBigInt(deck.operatorUid || 0) <= 0n) deck.operatorUid = String(toBigInt(operator.uid || operator.operatorUid || 0));

  const equipItems = buildPlayerDeckEquipItems(user, units);

  return {
    userUid: String(toBigInt(user.userUid || 0)),
    nickname: String(user.nickname || "LocalAdmin"),
    userLevel: Number(user.level || 1),
    deckType: deck.deckType,
    deckIndex: deck.index,
    leaderIndex,
    leaderUnitUid,
    shipUid: ship ? String(toBigInt(ship.unitUid || 0)) : "0",
    shipUnitId: ship ? Number(ship.unitId || 0) : 0,
    shipLevel: ship ? Number(ship.level || 1) : 1,
    shipSkinId: ship ? Number(ship.skinId || 0) : 0,
    operatorUid: operator ? String(toBigInt(operator.uid || operator.operatorUid || 0)) : "0",
    operatorId: operator ? Number(operator.id || operator.unitId || 0) : 0,
    operatorLevel: operator ? Number(operator.level || 1) : 1,
    equipItems,
    units,
  };
}

function normalizeAllowedUnitSlots(slots) {
  if (!Array.isArray(slots)) return null;
  const normalized = slots
    .map((slot) => Number(slot))
    .filter((slot) => Number.isInteger(slot) && slot >= 0 && slot < 8);
  if (!normalized.length) return null;
  return Array.from(new Set(normalized)).sort((a, b) => a - b);
}

function normalizeSlotUnitUidMap(slotUnitUids) {
  if (!slotUnitUids || typeof slotUnitUids !== "object") return null;
  const normalized = new Map();
  for (const [slot, unitUid] of Object.entries(slotUnitUids)) {
    const slotIndex = Number(slot);
    const uid = toBigInt(unitUid || 0);
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= 8 || uid <= 0n) continue;
    normalized.set(slotIndex, String(uid));
  }
  return normalized.size > 0 ? normalized : null;
}

function buildDeckUnitSlotAssignments(deck, allowedUnitSlots, explicitSlotUnitUids = null) {
  const unitUids = Array.isArray(deck && deck.unitUids) ? deck.unitUids : [];
  if (explicitSlotUnitUids) {
    const slots = allowedUnitSlots || Array.from(explicitSlotUnitUids.keys()).sort((a, b) => a - b);
    return slots
      .map((slotIndex) => ({ slotIndex, unitUid: explicitSlotUnitUids.get(slotIndex) || 0 }))
      .filter((assignment) => toBigInt(assignment.unitUid || 0) > 0n);
  }

  if (!allowedUnitSlots) {
    return unitUids.map((unitUid, slotIndex) => ({ slotIndex, unitUid }));
  }

  const used = new Set();
  const assignments = [];
  for (const slotIndex of allowedUnitSlots) {
    const unitUid = unitUids[slotIndex] || 0;
    if (toBigInt(unitUid || 0) <= 0n) continue;
    const key = String(toBigInt(unitUid));
    if (used.has(key)) continue;
    used.add(key);
    assignments.push({ slotIndex, unitUid });
  }

  const freeSlotsNeedingUnits = allowedUnitSlots.filter(
    (slotIndex) => !assignments.some((assignment) => assignment.slotIndex === slotIndex)
  );
  for (const slotIndex of freeSlotsNeedingUnits) {
    const unitUid = unitUids.find((uid) => {
      if (toBigInt(uid || 0) <= 0n) return false;
      const key = String(toBigInt(uid));
      return !used.has(key);
    });
    if (!unitUid) continue;
    used.add(String(toBigInt(unitUid)));
    assignments.push({ slotIndex, unitUid });
  }

  return assignments.sort((a, b) => a.slotIndex - b.slotIndex);
}

function resolveDeckIndexForGameLoad(user, req = {}) {
  const index = normalizeDeckIndex(req.selectDeckIndex || 0);
  if (toBigInt(req.raidUID || req.raidUid || 0) > 0n) return { deckType: DECK_TYPE_RAID, index };
  if (Number(req.diveStageID || 0) > 0) return { deckType: DECK_TYPE_DIVE, index };
  if (Number(req.exploreID || 0) > 0) return { deckType: DECK_TYPE_EXPLORE, index };

  const army = ensureArmy(user);
  const candidates = [];
  const last = army.lastCombatDeckIndex;
  if (last && normalizeDeckIndex(last.index) === index) {
    const lastDeckType = normalizeDeckType(last.deckType);
    if (lastDeckType === DECK_TYPE_DAILY || lastDeckType === DECK_TYPE_NORMAL) {
      candidates.push({ deckType: lastDeckType, index });
    }
  }
  candidates.push({ deckType: DECK_TYPE_DAILY, index });
  candidates.push({ deckType: DECK_TYPE_NORMAL, index });

  const seen = new Set();
  for (const candidate of candidates) {
    const key = `${candidate.deckType}:${candidate.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const deck = getDeckSet(army, candidate.deckType)[candidate.index];
    if (deckHasUnitUids(deck)) return candidate;
  }
  return { deckType: DECK_TYPE_DAILY, index };
}

function buildPlayerDeckUnit(unit, slotIndex) {
  const templet = getUnitTemplet(unit.unitId) || {};
  return {
    slotIndex,
    unitUid: String(toBigInt(unit.unitUid || 0)),
    unitId: Number(unit.unitId || 0),
    level: Number(unit.level || 1),
    skinId: Number(unit.skinId || 0),
    limitBreakLevel: Number(unit.limitBreakLevel || 0),
    tacticLevel: Number(unit.tacticLevel || 0),
    tacticGroup: Number(templet.m_TacticGroup || 0),
    skillLevels: normalizeSkillLevels(unit.skillLevels),
    equipItemUids: normalizeFixedArray(unit.equipItemUids, 4, 0).map((uid) => String(toBigInt(uid || 0))),
  };
}

function buildPlayerDeckEquipItems(user, units) {
  const inventory = user && user.inventory && typeof user.inventory === "object" ? user.inventory : {};
  const equips = inventory.equips && typeof inventory.equips === "object" ? inventory.equips : {};
  const output = [];
  const seen = new Set();

  for (const unit of Array.isArray(units) ? units : []) {
    const ownerUnitUid = String(toBigInt(unit && unit.unitUid || 0));
    for (const rawUid of normalizeFixedArray(unit && unit.equipItemUids, 4, 0)) {
      const equipUid = String(toBigInt(rawUid || 0));
      if (equipUid === "0" || seen.has(equipUid)) continue;
      const equip = equips[equipUid] || equips[String(rawUid)];
      if (!equip || typeof equip !== "object") continue;
      const serialized = buildPlayerDeckEquipItem(equip, equipUid, ownerUnitUid);
      if (!serialized) continue;
      output.push(serialized);
      seen.add(equipUid);
    }
  }

  return output;
}

function buildPlayerDeckEquipItem(equip, equipUid, ownerUnitUid) {
  const itemEquipId = Number(equip.itemEquipId != null ? equip.itemEquipId : equip.m_ItemEquipID || 0);
  if (!Number.isInteger(itemEquipId) || itemEquipId <= 0) return null;
  const stats = Array.isArray(equip.stats)
    ? equip.stats
    : Array.isArray(equip.m_Stat)
      ? equip.m_Stat
      : [];
  const potentialOptions = Array.isArray(equip.potentialOptions) ? equip.potentialOptions : [];

  return {
    equipUid,
    itemEquipId,
    enchantLevel: Number(equip.enchantLevel != null ? equip.enchantLevel : equip.m_EnchantLevel || 0) || 0,
    enchantExp: Number(equip.enchantExp != null ? equip.enchantExp : equip.m_EnchantExp || 0) || 0,
    stats: stats.map(buildPlayerDeckEquipStat).filter(Boolean),
    ownerUnitUid,
    locked: Boolean(equip.locked || equip.m_bLock),
    precision: Number(equip.precision != null ? equip.precision : equip.m_Precision || 0) || 0,
    precision2: Number(equip.precision2 != null ? equip.precision2 : equip.m_Precision2 || 0) || 0,
    setOptionId: Number(equip.setOptionId != null ? equip.setOptionId : equip.m_SetOptionId || 0) || 0,
    imprintUnitId: Number(equip.imprintUnitId != null ? equip.imprintUnitId : equip.m_ImprintUnitId || 0) || 0,
    potentialOptions: potentialOptions.map(buildPlayerDeckPotentialOption).filter(Boolean),
  };
}

function buildPlayerDeckEquipStat(stat) {
  if (!stat || typeof stat !== "object") return null;
  return {
    type: normalizeStatTypeName(stat.type != null ? stat.type : stat.statType),
    value: Number(stat.value != null ? stat.value : stat.stat_value || 0) || 0,
    levelValue: Number(stat.levelValue != null ? stat.levelValue : stat.stat_level_value || 0) || 0,
  };
}

function buildPlayerDeckPotentialOption(option) {
  if (!option || typeof option !== "object") return null;
  const sockets = normalizeFixedArray(option.sockets || option.socketData, 3, null);
  return {
    optionKey: Number(option.optionKey || option.optionId || 0) || 0,
    statType: normalizeStatTypeName(option.statType || option.type),
    sockets: sockets.map((socket) => {
      if (!socket || typeof socket !== "object") return null;
      return {
        statValue: Number(socket.statValue != null ? socket.statValue : socket.value || 0) || 0,
        precision: Number(socket.precision || 0) || 0,
      };
    }),
    precisionChangeCount: Number(option.precisionChangeCount || option.changeCount || 0) || 0,
  };
}

function normalizeStatTypeName(value) {
  return statTypeName(value) || "NST_RANDOM";
}

function grantUnit(user, unitIdOrStrId, options = {}) {
  if (!user) return null;
  const unitId = resolveUnitId(unitIdOrStrId);
  if (!Number.isInteger(unitId) || unitId <= 0) return null;

  const army = ensureArmy(user);
  const unitUid = allocateUnitUid(user);
  const unit = createUnitData(user, unitId, unitUid, options);
  const templet = getUnitTemplet(unitId);
  const storageKey = getUnitStorageKey(unitId);
  if (!templet || !storageKey) return null;
  const target = army[storageKey];
  target[unit.unitUid.toString()] = unit;

  user.collection = user.collection && typeof user.collection === "object" ? user.collection : {};
  const collectionKey = storageKey === "ships" ? "ships" : storageKey === "trophies" ? "trophies" : "units";
  user.collection[collectionKey] = Array.isArray(user.collection[collectionKey]) ? user.collection[collectionKey] : [];
  if (!user.collection[collectionKey].includes(unitId)) user.collection[collectionKey].push(unitId);

  return unit;
}

function grantOperator(user, unitIdOrStrId, options = {}) {
  if (!user) return null;
  const unitId = resolveUnitId(unitIdOrStrId);
  if (!Number.isInteger(unitId) || unitId <= 0) return null;
  const army = ensureArmy(user);
  const uid = allocateUnitUid(user);
  const operator = {
    id: unitId,
    uid: uid.toString(),
    level: Number(options.level || 1),
    exp: 0,
    locked: false,
    mainSkill: { id: Number(options.mainSkillId || 1001), level: 1, exp: 0 },
    subSkill: { id: Number(options.subSkillId || 1002), level: 1, exp: 0 },
    fromContract: options.fromContract !== false,
    regDate: String(options.regDate || dateTimeBinaryNow()),
  };
  army.operators[operator.uid] = operator;
  user.collection = user.collection && typeof user.collection === "object" ? user.collection : {};
  user.collection.operators = Array.isArray(user.collection.operators) ? user.collection.operators : [];
  if (!user.collection.operators.includes(unitId)) user.collection.operators.push(unitId);
  return operator;
}

function grantUnitFromPiece(user, itemId, count = 1, options = {}) {
  const piece = getPieceTemplet(itemId);
  if (!piece) return [];
  const grantCount = Math.max(1, Number(count) || 1);
  const units = [];
  for (let index = 0; index < grantCount; index += 1) {
    const unit = grantUnit(user, Number(piece.m_PieceGetUnitID), options);
    if (unit) units.push(unit);
  }
  return units;
}

function getPieceRequirement(itemId, alreadyOwned = false) {
  const piece = getPieceTemplet(itemId);
  if (!piece) return 0;
  return Number(alreadyOwned ? piece.m_PieceReq : piece.m_PieceReq_First) || Number(piece.m_PieceReq) || 1;
}

function createUnitData(user, unitId, unitUid, options = {}) {
  const templet = getUnitTemplet(unitId) || {};
  const maxStar = Math.max(0, Number(templet.m_StarGradeMax || 0));
  const unit = {
    unitUid: unitUid.toString(),
    userUid: toBigInt(user.userUid || 0).toString(),
    unitId,
    level: Number(options.level || 1),
    exp: Number(options.exp || 0),
    skinId: Number(options.skinId || 0),
    injury: 0,
    limitBreakLevel: Number(options.limitBreakLevel != null ? options.limitBreakLevel : 0),
    locked: false,
    summonUnit: false,
    statExp: [0, 0, 0, 0, 0, 0],
    gameUnitUids: [],
    gameUnitUidChanges: [],
    nearTargetRange: [],
    skillLevels: normalizeSkillLevels(options.skillLevels),
    equipItemUids: [0, 0, 0, 0],
    loyalty: resolveInitialUnitLoyalty(options),
    isPermanentContract: false,
    isSeized: false,
    fromContract: options.fromContract !== false,
    officeRoomId: 0,
    regDate: String(options.regDate || dateTimeBinaryNow()),
    officeGrade: 0,
    officeGaugeStartTime: "0",
    dungeonRespawnUnitTempletUid: "0",
    isFavorite: false,
    tacticLevel: Number(options.tacticLevel || 0),
    reactorLevel: Number(options.reactorLevel || 0),
  };
  if (options.maxLevelOverride != null) {
    unit.maxLevelOverride = Number(options.maxLevelOverride) || 0;
  }
  if (String(templet.m_NKM_UNIT_TYPE || "") === "NUT_SHIP") {
    unit.shipCommandModules = normalizeShipCommandModules(options.shipCommandModules || options.shipModules);
  }
  return unit;
}

function setUnitSkin(user, unitUid, skinId) {
  const army = ensureArmy(user);
  const unit = army.units[String(toBigInt(unitUid))] || army.ships[String(toBigInt(unitUid))] || army.trophies[String(toBigInt(unitUid))];
  if (!unit) return null;
  const numericSkinId = Number(skinId) || 0;
  if (numericSkinId > 0) {
    grantSkin(user, numericSkinId);
    user.collection = user.collection && typeof user.collection === "object" ? user.collection : {};
    user.collection.skins = Array.isArray(user.collection.skins) ? user.collection.skins : [];
    if (!user.collection.skins.includes(numericSkinId)) user.collection.skins.push(numericSkinId);
  }
  unit.skinId = numericSkinId;
  return unit;
}

function ensureDeck(user, deckIndex) {
  const army = ensureArmy(user);
  const deckType = normalizeDeckType(deckIndex && deckIndex.deckType);
  const index = normalizeDeckIndex(deckIndex && deckIndex.index);
  const deckSet = getDeckSet(army, deckType);
  while (deckSet.length <= index) deckSet.push(createDefaultDeck(deckType, deckSet.length));
  deckSet[index] = normalizeDeck(deckSet[index], deckType, index);
  return deckSet[index];
}

function swapDeckUnits(user, deckIndex, slotIndexFrom, slotIndexTo) {
  const deck = ensureDeck(user, deckIndex);
  const from = normalizeSlot(slotIndexFrom, deck.unitUids.length);
  const to = normalizeSlot(slotIndexTo, deck.unitUids.length);
  const previousFromUid = deck.unitUids[from] || 0;
  const previousToUid = deck.unitUids[to] || 0;
  deck.unitUids[from] = previousToUid;
  deck.unitUids[to] = previousFromUid;
  if (deck.leaderIndex === from) deck.leaderIndex = to;
  else if (deck.leaderIndex === to) deck.leaderIndex = from;
  rememberCombatDeck(user, deck);
  return {
    deck,
    slotIndexFrom: from,
    slotIndexTo: to,
    slotUnitUidFrom: deck.unitUids[from] || 0,
    slotUnitUidTo: deck.unitUids[to] || 0,
    previousFromUid,
    previousToUid,
  };
}

function setDeckLeader(user, deckIndex, leaderSlotIndex) {
  const deck = ensureDeck(user, deckIndex);
  const slot = Number(leaderSlotIndex);
  deck.leaderIndex = Number.isInteger(slot) && slot >= -1 && slot < deck.unitUids.length ? slot : -1;
  rememberCombatDeck(user, deck);
  return deck;
}

function unlockDeck(user, deckType) {
  const army = ensureArmy(user);
  const type = normalizeDeckType(deckType);
  const deckSet = getDeckSet(army, type);
  deckSet.push(createDefaultDeck(type, deckSet.length));
  return deckSet.length;
}

function setDeckUnit(user, deckIndex, slotIndex, unitUid) {
  const army = ensureArmy(user);
  let deck = ensureDeck(user, deckIndex);
  const slot = normalizeSlot(slotIndex, deck.unitUids.length);
  const normalizedUidBig = toBigInt(unitUid);
  const normalizedUid = String(normalizedUidBig);
  let old = { deckIndex: { deckType: 0, index: 0 }, slotIndex: -1 };
  if (normalizedUidBig > 0n) {
    if (deck.deckType === DECK_TYPE_DIVE) {
      old = findDeckUnit(army, normalizedUid, { deckType: deck.deckType });
    } else {
      const oldSlotIndex = deck.unitUids.findIndex((uid) => String(toBigInt(uid)) === normalizedUid);
      if (oldSlotIndex >= 0) old = { deckIndex: { deckType: deck.deckType, index: deck.index }, slotIndex: oldSlotIndex };
    }
  }
  deck = ensureDeck(user, deckIndex);
  let oldLeaderSlotIndex = -1;
  let movedLeaderFromSameDeck = false;

  if (normalizedUidBig > 0n && old.slotIndex >= 0) {
    const sameDeck = old.deckIndex.deckType === deck.deckType && old.deckIndex.index === deck.index;
    const oldDeck = sameDeck ? deck : ensureDeck(user, old.deckIndex);
    const sameTargetSlot = sameDeck && old.slotIndex === slot;
    if (sameTargetSlot) {
      oldLeaderSlotIndex = deck.leaderIndex;
    } else {
      const wasOldLeader = oldDeck.leaderIndex === old.slotIndex;
      movedLeaderFromSameDeck =
        wasOldLeader && old.deckIndex.deckType === deck.deckType && old.deckIndex.index === deck.index && old.slotIndex !== slot;
      oldDeck.unitUids[old.slotIndex] = 0;
      oldLeaderSlotIndex = wasOldLeader ? firstFilledUnitSlot(oldDeck) : oldDeck.leaderIndex;
      oldDeck.leaderIndex = oldLeaderSlotIndex;
      if (!sameDeck) deck = ensureDeck(user, deckIndex);
    }
  }

  deck.unitUids[slot] = normalizedUidBig > 0n ? normalizedUid : 0;
  if (normalizedUidBig <= 0n && deck.leaderIndex === slot) {
    deck.leaderIndex = firstFilledUnitSlot(deck);
  } else if (movedLeaderFromSameDeck) {
    deck.leaderIndex = slot;
  } else if (deck.leaderIndex < 0 && normalizedUidBig > 0n) {
    deck.leaderIndex = slot;
  }
  if (old.deckIndex.deckType === deck.deckType && old.deckIndex.index === deck.index) oldLeaderSlotIndex = deck.leaderIndex;
  rememberCombatDeck(user, deck);
  return { deck, oldDeckIndex: old.deckIndex, oldSlotIndex: old.slotIndex, oldLeaderSlotIndex };
}

function autoSetDeck(user, deckIndex, unitUids, shipUid = 0, operatorUid = 0) {
  const deck = ensureDeck(user, deckIndex);
  const slots = normalizeFixedArray(unitUids || [], deck.unitUids.length, 0);
  deck.unitUids = slots.map((uid) => (toBigInt(uid) > 0n ? String(toBigInt(uid)) : 0));
  deck.shipUid = toBigInt(shipUid) > 0n ? String(toBigInt(shipUid)) : 0;
  deck.operatorUid = toBigInt(operatorUid) > 0n ? String(toBigInt(operatorUid)) : 0;
  deck.leaderIndex = deck.unitUids.findIndex((uid) => toBigInt(uid) > 0n);
  rememberCombatDeck(user, deck);
  return deck;
}

function setDeckShip(user, deckIndex, shipUid) {
  const army = ensureArmy(user);
  const normalizedUid = String(toBigInt(shipUid));
  let deck = ensureDeck(user, deckIndex);
  const isDiveTransfer = deck.deckType === DECK_TYPE_DIVE && toBigInt(normalizedUid) > 0n;
  const oldDeckIndex = isDiveTransfer
    ? findDeckShip(army, normalizedUid, { deckType: deck.deckType })
    : { deckType: 0, index: 0 };
  if (isDiveTransfer) clearShipFromDecks(army, normalizedUid, { deckType: deck.deckType });
  deck = ensureDeck(user, deckIndex);
  deck.shipUid = toBigInt(normalizedUid) > 0n ? normalizedUid : 0;
  rememberCombatDeck(user, deck);
  return { deck, oldDeckIndex };
}

function setDeckOperator(user, deckIndex, operatorUid) {
  const army = ensureArmy(user);
  const normalizedUid = String(toBigInt(operatorUid));
  let deck = ensureDeck(user, deckIndex);
  const isDiveTransfer = deck.deckType === DECK_TYPE_DIVE && toBigInt(normalizedUid) > 0n;
  const oldDeckIndex = isDiveTransfer
    ? findDeckOperator(army, normalizedUid, { deckType: deck.deckType })
    : { deckType: 0, index: 0 };
  if (isDiveTransfer) clearOperatorFromDecks(army, normalizedUid, { deckType: deck.deckType });
  deck = ensureDeck(user, deckIndex);
  deck.operatorUid = toBigInt(normalizedUid) > 0n ? normalizedUid : 0;
  rememberCombatDeck(user, deck);
  return { deck, oldDeckIndex };
}

function updateDeckName(user, deckIndex, name) {
  const deck = ensureDeck(user, deckIndex);
  deck.name = String(name || "").slice(0, 32);
  rememberCombatDeck(user, deck);
  return deck;
}

function getArmyUnitByUid(user, unitUid) {
  const army = ensureArmy(user);
  const key = String(toBigInt(unitUid || 0));
  return normalizeUnit(army.units[key]) || normalizeUnit(army.ships[key]) || normalizeUnit(army.trophies[key]) || null;
}

function getArmyOperatorByUid(user, operatorUid) {
  const army = ensureArmy(user);
  const key = String(toBigInt(operatorUid || 0));
  const operator = normalizeOperatorData(army.operators[key]);
  if (operator) army.operators[operator.uid] = operator;
  return operator;
}

function addUnitExp(user, unitUid, amount, options = {}) {
  const unit = getArmyUnitByUid(user, unitUid);
  if (!unit) return null;
  const maxLevel = getUnitMaxLevel(unit, options);
  const currentTotalExp = getUnitCurrentTotalExp(unit, maxLevel);
  const next = splitUnitTotalExp(currentTotalExp + Math.max(0, Number(amount || 0)), maxLevel);
  unit.level = next.level;
  unit.exp = next.exp;
  if (options.loyalty != null) unit.loyalty = clampInt(options.loyalty, 0, MAX_UNIT_LOYALTY);
  unit.lastGrowthAt = new Date().toISOString();
  persistNormalizedUnit(user, unit);
  return unit;
}

function setUnitLevel(user, unitUid, level, options = {}) {
  const unit = getArmyUnitByUid(user, unitUid);
  if (!unit) return null;
  const maxLevel = getUnitMaxLevel(unit, options);
  unit.level = clampInt(level, 1, maxLevel);
  unit.exp = 0;
  unit.lastGrowthAt = new Date().toISOString();
  persistNormalizedUnit(user, unit);
  return unit;
}

function enhanceUnitStats(user, unitUid, consumeUnitUids = []) {
  const unit = getArmyUnitByUid(user, unitUid);
  if (!unit) return null;
  const consumeList = uniqueUidStrings(consumeUnitUids).filter((uid) => uid !== String(toBigInt(unitUid || 0)));
  const gain = Math.max(1, consumeList.length) * 100;
  unit.statExp = normalizeFixedArray(unit.statExp, 6, 0).map((value, index) => {
    const ratio = index < 3 ? 1 : 0.5;
    return Math.min(999999, Math.max(0, Number(value || 0)) + Math.floor(gain * ratio));
  });
  removeArmyUnitUids(user, consumeList);
  unit.lastGrowthAt = new Date().toISOString();
  persistNormalizedUnit(user, unit);
  return unit;
}

function limitBreakUnit(user, unitUid, options = {}) {
  const unit = getArmyUnitByUid(user, unitUid);
  if (!unit) return null;
  unit.limitBreakLevel = getNextUnitLimitBreakRank(unit, options);
  unit.level = Math.min(Number(unit.level || 1), getUnitMaxLevel(unit));
  unit.lastGrowthAt = new Date().toISOString();
  persistNormalizedUnit(user, unit);
  return unit;
}

function getNextUnitLimitBreakRank(unit, options = {}) {
  const currentRank = Math.max(0, Number(unit && unit.limitBreakLevel) || 0);
  const cap = Math.max(1, Number(options.maxLimitBreakLevel || getMaxLimitBreakRank({ maxLevel: UNIT_LIMIT_BREAK_MAX_LEVEL })));
  const nextRank = options.maxLimitBreakLevel == null && Number(unit && unit.level) >= 100 && currentRank < 3 ? 4 : currentRank + 1;
  return clampInt(nextRank, 0, cap);
}

function upgradeUnitSkill(user, unitUid, skillId, options = {}) {
  const unit = getArmyUnitByUid(user, unitUid);
  if (!unit) return null;
  const levels = normalizeSkillLevels(unit.skillLevels);
  const index = resolveSkillIndex(unit, skillId);
  const maxLevel = Math.max(1, Number(options.maxSkillLevel || getUnitSkillMaxLevel(skillId) || 5));
  levels[index] = clampInt(Number(levels[index] || 1) + 1, 1, maxLevel);
  unit.skillLevels = levels;
  unit.lastGrowthAt = new Date().toISOString();
  persistNormalizedUnit(user, unit);
  return { unit, skillLevel: levels[index], skillIndex: index };
}

function tacticUpdateUnit(user, unitUid, consumeUnitUids = []) {
  const unit = getArmyUnitByUid(user, unitUid);
  if (!unit) return null;
  const consumeList = uniqueUidStrings(consumeUnitUids).filter((uid) => uid !== String(toBigInt(unitUid || 0)));
  unit.tacticLevel = clampInt(Number(unit.tacticLevel || 0) + Math.max(1, consumeList.length), 0, 6);
  removeArmyUnitUids(user, consumeList);
  unit.lastGrowthAt = new Date().toISOString();
  persistNormalizedUnit(user, unit);
  return unit;
}

function reactorLevelUpUnit(user, unitUid) {
  const unit = getArmyUnitByUid(user, unitUid);
  if (!unit) return null;
  unit.reactorLevel = clampInt(Number(unit.reactorLevel || 0) + 1, 0, 5);
  unit.lastGrowthAt = new Date().toISOString();
  persistNormalizedUnit(user, unit);
  return unit;
}

function permanentlyContractUnit(user, unitUid) {
  const unit = getArmyUnitByUid(user, unitUid);
  if (!unit) return null;
  unit.isPermanentContract = true;
  unit.loyalty = Math.max(Number(unit.loyalty || 0), MAX_UNIT_LOYALTY);
  unit.lastGrowthAt = new Date().toISOString();
  persistNormalizedUnit(user, unit);
  return unit;
}

function rearmUnit(user, unitUid, rearmamentId) {
  const unit = getArmyUnitByUid(user, unitUid);
  const nextUnitId = resolveUnitId(rearmamentId);
  if (!unit || !nextUnitId) return unit || null;
  unit.previousUnitId = Number(unit.unitId || 0);
  unit.unitId = nextUnitId;
  unit.rearmedAt = new Date().toISOString();
  unit.lastGrowthAt = unit.rearmedAt;
  persistNormalizedUnit(user, unit);
  return unit;
}

function setShipLevel(user, shipUid, nextLevel) {
  const ship = getArmyUnitByUid(user, shipUid);
  if (!ship) return null;
  return setUnitLevel(user, shipUid, nextLevel, { maxLevel: getShipMaxLevel(ship) });
}

function upgradeShip(user, shipUid, nextShipId) {
  const ship = getArmyUnitByUid(user, shipUid);
  const nextUnitId = resolveUnitId(nextShipId);
  if (!ship || !nextUnitId) return ship || null;
  ship.previousUnitId = Number(ship.unitId || 0);
  ship.unitId = nextUnitId;
  ship.upgradedAt = new Date().toISOString();
  persistNormalizedUnit(user, ship);
  return ship;
}

function limitBreakShip(user, shipUid, consumeShipUid = 0) {
  const ship = limitBreakUnit(user, shipUid, { maxLimitBreakLevel: 6 });
  if (toBigInt(consumeShipUid || 0) > 0n) removeArmyUnitUids(user, [consumeShipUid]);
  return ship;
}

function setUnitLock(user, unitUid, locked) {
  const unit = getArmyUnitByUid(user, unitUid);
  if (!unit) return null;
  unit.locked = Boolean(locked);
  persistNormalizedUnit(user, unit);
  return unit;
}

function setUnitFavorite(user, unitUid, isFavorite) {
  const unit = getArmyUnitByUid(user, unitUid);
  if (!unit) return null;
  unit.isFavorite = Boolean(isFavorite);
  persistNormalizedUnit(user, unit);
  return unit;
}

function setOperatorLock(user, operatorUid, locked) {
  const operator = getArmyOperatorByUid(user, operatorUid);
  if (!operator) return null;
  operator.locked = Boolean(locked);
  operator.bLock = operator.locked;
  return operator;
}

function levelOperator(user, operatorUid, materialCount = 1) {
  return addOperatorExp(user, operatorUid, Math.max(1, Number(materialCount || 1)) * 100);
}

function addOperatorExp(user, operatorUid, amount, options = {}) {
  const operator = getArmyOperatorByUid(user, operatorUid);
  if (!operator) return null;
  const maxLevel = getOperatorGrowthMaxLevel(operator, options);
  const currentTotalExp = getOperatorCurrentTotalExp(operator, maxLevel);
  const next = splitOperatorTotalExp(getOperatorGrade(operator), currentTotalExp + Math.max(0, Number(amount || 0)), maxLevel);
  operator.level = next.level;
  operator.exp = next.exp;
  operator.lastGrowthAt = new Date().toISOString();
  persistNormalizedOperator(user, operator);
  return operator;
}

function enhanceOperator(user, targetOperatorUid, sourceOperatorUid = 0, options = {}) {
  const operator = getArmyOperatorByUid(user, targetOperatorUid);
  if (!operator) return null;
  const skill = options.transSkill ? "subSkill" : "mainSkill";
  operator[skill] = operator[skill] && typeof operator[skill] === "object" ? operator[skill] : { id: skill === "subSkill" ? 1002 : 1001 };
  operator[skill].level = clampInt(Number(operator[skill].level || 1) + 1, 1, 8);
  operator[skill].exp = Math.max(0, Number(operator[skill].exp || 0));
  if (toBigInt(sourceOperatorUid || 0) > 0n) removeOperatorUids(user, [sourceOperatorUid]);
  operator.lastGrowthAt = new Date().toISOString();
  return operator;
}

function removeArmyUnitUids(user, unitUids = []) {
  const army = ensureArmy(user);
  const removed = [];
  for (const uid of uniqueUidStrings(unitUids)) {
    if (army.units[uid]) {
      delete army.units[uid];
      clearUnitFromDecks(army, uid);
      removed.push(uid);
    }
    if (army.ships[uid]) {
      delete army.ships[uid];
      clearShipFromDecks(army, uid);
      removed.push(uid);
    }
    if (army.trophies[uid]) {
      delete army.trophies[uid];
      removed.push(uid);
    }
  }
  return removed;
}

function removeOperatorUids(user, operatorUids = []) {
  const army = ensureArmy(user);
  const removed = [];
  for (const uid of uniqueUidStrings(operatorUids)) {
    if (!army.operators[uid]) continue;
    delete army.operators[uid];
    clearOperatorFromDecks(army, uid);
    removed.push(uid);
  }
  return removed;
}

function normalizeUnit(value) {
  if (!value || typeof value !== "object") return null;
  const unitUid = toBigInt(value.unitUid != null ? value.unitUid : value.m_UnitUID || 0);
  const unitId = Number(value.unitId != null ? value.unitId : value.m_UnitID || 0);
  if (unitUid <= 0n || !Number.isInteger(unitId) || unitId <= 0) return null;
  return normalizeUnitExpShape({
    ...value,
    unitUid: unitUid.toString(),
    userUid: toBigInt(value.userUid != null ? value.userUid : value.m_UserUID || 0).toString(),
    unitId,
    level: Number(value.level || value.m_UnitLevel || 1),
    exp: Number(value.exp || value.m_iUnitLevelEXP || 0),
    statExp: normalizeFixedArray(value.statExp || value.m_listStatEXP, 6, 0),
    skillLevels: normalizeSkillLevels(value.skillLevels || value.m_aUnitSkillLevel),
    equipItemUids: normalizeFixedArray(value.equipItemUids || value.m_EquipItemList, 4, 0),
    shipCommandModules: normalizeShipCommandModules(value.shipCommandModules || value.ShipCommandModule || value.shipModules),
    maxLevelOverride: Number(value.maxLevelOverride || 0) || 0,
    regDate: String(value.regDate || value.m_regDate || dateTimeBinaryNow()),
  });
}

function persistNormalizedUnit(user, unit) {
  if (!user || !unit) return null;
  const army = ensureArmy(user);
  const normalized = normalizeUnit(unit);
  if (!normalized) return null;
  const storageKey = getUnitStorageKey(normalized.unitId);
  if (!storageKey) return null;
  const target = army[storageKey];
  delete army.units[normalized.unitUid];
  delete army.ships[normalized.unitUid];
  delete army.trophies[normalized.unitUid];
  target[normalized.unitUid] = normalized;
  return normalized;
}

function getUnitMaxLevel(unit, options = {}) {
  if (options.maxLevel != null) return Math.max(1, Number(options.maxLevel) || 1);
  const storedLevel = Math.max(1, Number(unit && unit.level) || 1);
  const templet = getUnitTemplet(unit && unit.unitId);
  if (templet && String(templet.m_NKM_UNIT_TYPE || "") === "NUT_SHIP") {
    return Math.max(storedLevel, getShipMaxLevel(unit));
  }
  const limitBreakLevel = Math.max(0, Number(unit && unit.limitBreakLevel) || 0);
  const reactorLevel = Math.max(0, Number(unit && unit.reactorLevel) || 0);
  const maxRank = getMaxLimitBreakRank({ maxLevel: UNIT_LIMIT_BREAK_MAX_LEVEL });
  const tableMaxLevel = getLimitBreakMaxLevel(Math.min(limitBreakLevel, maxRank), 100);
  const resolvedMaxLevel = Math.min(UNIT_LIMIT_BREAK_MAX_LEVEL, tableMaxLevel + reactorLevel);
  const override = Number(unit && unit.maxLevelOverride || 0) || 0;
  if (override > 0 && !isStaleAwakenedMaxLevelOverride(unit, override, resolvedMaxLevel)) {
    return Math.max(storedLevel, override);
  }
  // Persisted/imported progress is authoritative. Missing lookup tables must never lower it.
  return Math.max(storedLevel, resolvedMaxLevel);
}

function isStaleAwakenedMaxLevelOverride(unit, override, resolvedMaxLevel) {
  if (override !== 110 || resolvedMaxLevel <= override) return false;
  const templet = getUnitTemplet(unit && unit.unitId);
  return templet && templet.m_bAwaken === true;
}

function resolveInitialUnitLoyalty(options = {}) {
  if (options.loyalty != null) return clampInt(options.loyalty, 0, MAX_UNIT_LOYALTY);
  return isEnvEnabled("CS_NEW_UNIT_MAX_LOYALTY") ? MAX_UNIT_LOYALTY : DEFAULT_NEW_UNIT_LOYALTY;
}

function isEnvEnabled(name) {
  const value = String(process.env[name] || "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function normalizeUnitExpShape(unit, options = {}) {
  if (!unit || typeof unit !== "object") return unit;
  const maxLevel = getUnitMaxLevel(unit, options);
  unit.level = clampInt(unit.level || 1, 1, maxLevel);
  unit.exp = Math.max(0, Math.trunc(Number(unit.exp || 0) || 0));
  if (unit.level >= maxLevel) return unit;
  const required = getUnitRequiredExpForLevel(unit.level);
  if (required > 0 && unit.exp >= required) {
    const next = splitUnitTotalExp(unit.exp, maxLevel);
    unit.level = next.level;
    unit.exp = next.exp;
  }
  return unit;
}

function getUnitCurrentTotalExp(unit, maxLevel = getUnitMaxLevel(unit)) {
  normalizeUnitExpShape(unit, { maxLevel });
  return Math.max(0, getTotalExpForUnitLevel(unit.level) + Number(unit.exp || 0));
}

function getUnitRequiredExpForLevel(level) {
  const current = getTotalExpForUnitLevel(level);
  const next = getTotalExpForUnitLevel(Number(level || 0) + 1);
  return next > current ? next - current : 0;
}

function splitUnitTotalExp(totalExp, maxLevel = UNIT_LIMIT_BREAK_MAX_LEVEL) {
  const cap = Math.max(1, Number(maxLevel) || 1);
  const hasTable = getTotalExpForUnitLevel(2) > 0 || getTotalExpForUnitLevel(cap) > 0;
  if (!hasTable) {
    const bounded = Math.max(0, Math.trunc(Number(totalExp) || 0));
    const level = clampInt(1 + Math.floor(bounded / 100), 1, cap);
    return { level, exp: level >= cap ? 0 : bounded % 100 };
  }

  const maxTotalExp = getTotalExpForUnitLevel(cap);
  const bounded = maxTotalExp > 0 ? Math.min(Math.max(0, Number(totalExp) || 0), maxTotalExp) : Math.max(0, Number(totalExp) || 0);
  const level = getUnitLevelByTotalExp(bounded, cap);
  if (level >= cap && maxTotalExp > 0 && bounded >= maxTotalExp) return { level: cap, exp: 0 };
  const base = getTotalExpForUnitLevel(level);
  const required = getUnitRequiredExpForLevel(level);
  let exp = Math.max(0, Math.trunc(bounded - base));
  if (required > 0) exp = Math.min(exp, required - 1);
  return { level, exp };
}

function normalizeOperatorData(value) {
  if (!value || typeof value !== "object") return null;
  const uid = toBigInt(value.uid != null ? value.uid : value.operatorUid != null ? value.operatorUid : value.m_OperatorUID || 0);
  const id = Number(value.id != null ? value.id : value.unitId != null ? value.unitId : value.m_UnitID || 0);
  if (uid <= 0n || !Number.isInteger(id) || id <= 0) return null;
  const operator = {
    ...value,
    id,
    uid: uid.toString(),
    level: Number(value.level || 1),
    exp: Number(value.exp || 0),
    locked: Boolean(value.locked || value.bLock),
    mainSkill: value.mainSkill && typeof value.mainSkill === "object" ? value.mainSkill : { id: 1001, level: 1, exp: 0 },
    subSkill: value.subSkill && typeof value.subSkill === "object" ? value.subSkill : { id: 1002, level: 1, exp: 0 },
  };
  return normalizeOperatorExpShape(operator);
}

function normalizeOperatorExpShape(operator, options = {}) {
  if (!operator || typeof operator !== "object") return operator;
  const maxLevel = getOperatorGrowthMaxLevel(operator, options);
  operator.level = clampInt(operator.level || 1, 1, maxLevel);
  operator.exp = Math.max(0, Math.trunc(Number(operator.exp || 0) || 0));
  if (operator.level >= maxLevel) {
    operator.exp = 0;
    return operator;
  }
  const required = getOperatorRequiredExpForLevel(getOperatorGrade(operator), operator.level);
  if (required > 0 && operator.exp >= required) {
    const next = splitOperatorTotalExp(getOperatorGrade(operator), operator.exp, maxLevel);
    operator.level = next.level;
    operator.exp = next.exp;
  }
  return operator;
}

function getOperatorGrowthMaxLevel(operator, options = {}) {
  if (options.maxLevel != null) return Math.max(1, Number(options.maxLevel) || 1);
  return Math.max(1, Number(getOperatorMaxLevel(getOperatorGrade(operator)) || 100) || 100);
}

function getOperatorCurrentTotalExp(operator, maxLevel = getOperatorGrowthMaxLevel(operator)) {
  normalizeOperatorExpShape(operator, { maxLevel });
  return Math.max(0, getOperatorTotalExpForLevel(getOperatorGrade(operator), operator.level) + Number(operator.exp || 0));
}

function splitOperatorTotalExp(grade, totalExp, maxLevel = getOperatorMaxLevel(grade)) {
  const cap = Math.max(1, Number(maxLevel) || 1);
  const maxTotalExp = getOperatorTotalExpForLevel(grade, cap);
  const hasTable = getOperatorRequiredExpForLevel(grade, 1) > 0 || maxTotalExp > 0;
  if (!hasTable) {
    const bounded = Math.max(0, Math.trunc(Number(totalExp) || 0));
    const level = clampInt(1 + Math.floor(bounded / 100), 1, cap);
    return { level, exp: level >= cap ? 0 : bounded % 100 };
  }

  const bounded = maxTotalExp > 0 ? Math.min(Math.max(0, Number(totalExp) || 0), maxTotalExp) : Math.max(0, Number(totalExp) || 0);
  const level = getOperatorLevelByTotalExp(grade, bounded, cap);
  if (level >= cap && maxTotalExp > 0 && bounded >= maxTotalExp) return { level: cap, exp: 0 };
  const base = getOperatorTotalExpForLevel(grade, level);
  const required = getOperatorRequiredExpForLevel(grade, level);
  let exp = Math.max(0, Math.trunc(bounded - base));
  if (required > 0) exp = Math.min(exp, required - 1);
  return { level, exp };
}

function getOperatorGrade(operator) {
  const templet = getUnitTemplet(Number(operator && (operator.id || operator.unitId) || 0)) || {};
  return String(templet.m_NKM_UNIT_GRADE || "NUG_SSR");
}

function persistNormalizedOperator(user, operator) {
  if (!user || !operator) return null;
  const army = ensureArmy(user);
  const normalized = normalizeOperatorData(operator);
  if (!normalized) return null;
  army.operators[normalized.uid] = normalized;
  return normalized;
}

function resolveSkillIndex(unit, skillId) {
  const numeric = Number(skillId || 0);
  const mappedIndex = getUnitSkillIndex(unit && unit.unitId, numeric);
  if (mappedIndex >= 0) return mappedIndex;
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 5) return numeric - 1;
  const levels = normalizeSkillLevels(unit && unit.skillLevels);
  const firstOpen = levels.findIndex((level) => Number(level || 1) < 5);
  if (firstOpen >= 0) return firstOpen;
  return 0;
}

function uniqueUidStrings(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(toBigInt(value || 0)))
        .filter((value) => toBigInt(value) > 0n)
    )
  );
}

function clampInt(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.max(min, Math.min(max, Math.trunc(numeric)));
}

function isSerializableArmyUnit(unit) {
  const templet = getUnitTemplet(unit.unitId);
  if (!templet) return false;
  const type = String(templet.m_NKM_UNIT_TYPE || "");
  const style = String(templet.m_NKM_UNIT_STYLE_TYPE || "");
  return type !== "NUT_SHIP" && type !== "NUT_OPERATOR" && type !== "NUT_SYSTEM" && style !== "NUST_TRAINER";
}

function isTrophyUnitId(unitId) {
  const templet = getUnitTemplet(unitId);
  return Boolean(templet && String(templet.m_NKM_UNIT_STYLE_TYPE || "") === "NUST_TRAINER");
}

function getUnitStorageKey(unitId) {
  const templet = getUnitTemplet(unitId);
  if (!templet || templet.m_bMonster === true) return null;
  const type = String(templet.m_NKM_UNIT_TYPE || "");
  if (type === "NUT_SHIP") return "ships";
  if (type === "NUT_OPERATOR" || type === "NUT_SYSTEM") return null;
  return isTrophyUnitId(unitId) ? "trophies" : "units";
}

function normalizeUnitMap(map) {
  for (const [key, value] of Object.entries(map)) {
    const unit = normalizeUnit(value);
    if (!unit || toBigInt(unit.unitUid) <= 0n || unit.unitId <= 0) {
      delete map[key];
      continue;
    }
    if (String(key) !== String(unit.unitUid)) delete map[key];
    map[String(unit.unitUid)] = unit;
  }
}

function normalizeArmyUnitBuckets(army) {
  const buckets = [army.units, army.ships, army.trophies];
  const units = [];
  for (const bucket of buckets) {
    for (const value of Object.values(bucket)) {
      const unit = normalizeUnit(value);
      if (unit) units.push(unit);
    }
    for (const key of Object.keys(bucket)) delete bucket[key];
  }
  for (const unit of units) {
    const storageKey = getUnitStorageKey(unit.unitId) || "units";
    army[storageKey][unit.unitUid] = unit;
  }
}

function normalizeOperatorMap(map) {
  for (const [key, value] of Object.entries(map)) {
    const operator = normalizeOperatorData(value);
    if (!operator || toBigInt(operator.uid) <= 0n || operator.id <= 0) {
      delete map[key];
      continue;
    }
    if (String(key) !== String(operator.uid)) delete map[key];
    map[String(operator.uid)] = operator;
  }
}

function normalizeDeckSets(army) {
  for (let deckType = 0; deckType <= 10; deckType += 1) getDeckSet(army, deckType);
}

function sanitizeDeckReferences(army) {
  const unitUids = new Set(Object.keys(army.units || {}).map((uid) => String(toBigInt(uid || 0))));
  const shipUids = new Set(Object.keys(army.ships || {}).map((uid) => String(toBigInt(uid || 0))));
  const operatorUids = new Set(Object.keys(army.operators || {}).map((uid) => String(toBigInt(uid || 0))));

  for (const decks of Object.values(army.deckSets || {})) {
    if (!Array.isArray(decks)) continue;
    for (const deck of decks) {
      if (!deck || typeof deck !== "object") continue;
      const seenUnits = new Set();
      deck.unitUids = normalizeFixedArray(deck.unitUids, Number(deck.deckType || 0) === 4 ? 16 : 8, 0).map((uid) => {
        const key = String(toBigInt(uid || 0));
        if (key === "0" || !unitUids.has(key) || seenUnits.has(key)) return 0;
        seenUnits.add(key);
        return key;
      });
      const shipUid = String(toBigInt(deck.shipUid || 0));
      if (shipUid === "0" || !shipUids.has(shipUid)) deck.shipUid = 0;
      const operatorUid = String(toBigInt(deck.operatorUid || 0));
      if (operatorUid === "0" || !operatorUids.has(operatorUid)) deck.operatorUid = 0;
      if (
        !Number.isInteger(deck.leaderIndex) ||
        deck.leaderIndex < 0 ||
        deck.leaderIndex >= deck.unitUids.length ||
        toBigInt(deck.unitUids[deck.leaderIndex] || 0) <= 0n
      ) {
        deck.leaderIndex = firstFilledUnitSlot(deck);
      }
    }
  }
}

function getDeckSet(army, deckType) {
  const type = normalizeDeckType(deckType);
  const key = String(type);
  const defaults = defaultDeckCount(type);
  army.deckSets[key] = Array.isArray(army.deckSets[key]) ? army.deckSets[key] : [];
  while (army.deckSets[key].length < defaults) army.deckSets[key].push(createDefaultDeck(type, army.deckSets[key].length));
  army.deckSets[key] = army.deckSets[key].map((deck, index) => normalizeDeck(deck, type, index));
  return army.deckSets[key];
}

function createDefaultDeck(deckType, index) {
  const slotCount = deckType === 4 ? 16 : 8;
  return {
    deckType,
    index,
    name: "",
    shipUid: 0,
    operatorUid: 0,
    unitUids: Array.from({ length: slotCount }, () => 0),
    leaderIndex: -1,
    state: 0,
  };
}

function normalizeDeck(deck, deckType, index = 0) {
  const slotCount = deckType === 4 ? 16 : 8;
  const data = deck && typeof deck === "object" ? deck : {};
  return {
    deckType,
    index: Number(data.index != null ? data.index : index) || 0,
    name: String(data.name != null ? data.name : data.deckName || ""),
    shipUid: toBigInt(data.shipUid != null ? data.shipUid : data.m_ShipUID || 0) > 0n
      ? String(toBigInt(data.shipUid != null ? data.shipUid : data.m_ShipUID || 0))
      : 0,
    operatorUid: toBigInt(data.operatorUid != null ? data.operatorUid : data.m_OperatorUID || 0) > 0n
      ? String(toBigInt(data.operatorUid != null ? data.operatorUid : data.m_OperatorUID || 0))
      : 0,
    unitUids: normalizeFixedArray(data.unitUids || data.m_listDeckUnitUID, slotCount, 0).map((uid) =>
      toBigInt(uid) > 0n ? String(toBigInt(uid)) : 0
    ),
    leaderIndex: Number(data.leaderIndex != null ? data.leaderIndex : data.m_LeaderIndex != null ? data.m_LeaderIndex : -1),
    state: Number(data.state != null ? data.state : data.m_DeckState || 0) || 0,
  };
}

function firstFilledUnitSlot(deck) {
  const units = Array.isArray(deck && deck.unitUids) ? deck.unitUids : [];
  const index = units.findIndex((uid) => toBigInt(uid) > 0n);
  return index >= 0 ? index : -1;
}

function deckHasUnitUids(deck) {
  return Array.isArray(deck && deck.unitUids) && deck.unitUids.some((uid) => toBigInt(uid) > 0n);
}

function rememberCombatDeck(user, deckIndex) {
  if (!user || !deckIndex) return;
  const deckType = normalizeDeckType(deckIndex.deckType);
  if (![DECK_TYPE_NORMAL, DECK_TYPE_DAILY, DECK_TYPE_RAID, DECK_TYPE_DIVE, DECK_TYPE_EXPLORE].includes(deckType)) return;
  const army = ensureArmy(user);
  army.lastCombatDeckIndex = {
    deckType,
    index: normalizeDeckIndex(deckIndex.index),
    updatedAt: new Date().toISOString(),
  };
}

function findDeckUnit(army, unitUid, options = {}) {
  const normalizedUid = String(toBigInt(unitUid));
  for (const [type, decks] of deckSetEntries(army, options.deckType)) {
    for (let index = 0; index < decks.length; index += 1) {
      const slotIndex = (decks[index].unitUids || []).findIndex((uid) => String(toBigInt(uid)) === normalizedUid);
      if (slotIndex >= 0) return { deckIndex: { deckType: Number(type), index }, slotIndex };
    }
  }
  return { deckIndex: { deckType: 0, index: 0 }, slotIndex: -1 };
}

function findDeckShip(army, shipUid, options = {}) {
  const normalizedUid = String(toBigInt(shipUid));
  for (const [type, decks] of deckSetEntries(army, options.deckType)) {
    for (let index = 0; index < decks.length; index += 1) {
      if (String(toBigInt(decks[index].shipUid || 0)) === normalizedUid) return { deckType: Number(type), index };
    }
  }
  return { deckType: 0, index: 0 };
}

function findDeckOperator(army, operatorUid, options = {}) {
  const normalizedUid = String(toBigInt(operatorUid));
  for (const [type, decks] of deckSetEntries(army, options.deckType)) {
    for (let index = 0; index < decks.length; index += 1) {
      if (String(toBigInt(decks[index].operatorUid || 0)) === normalizedUid) return { deckType: Number(type), index };
    }
  }
  return { deckType: 0, index: 0 };
}

function clearUnitFromDecks(army, unitUid) {
  const normalizedUid = String(toBigInt(unitUid));
  for (const decks of Object.values(army.deckSets || {})) {
    for (const deck of decks) {
      deck.unitUids = deck.unitUids.map((uid) => (String(toBigInt(uid)) === normalizedUid ? 0 : uid));
    }
  }
}

function clearShipFromDecks(army, shipUid, options = {}) {
  const normalizedUid = String(toBigInt(shipUid));
  for (const [, decks] of deckSetEntries(army, options.deckType)) {
    for (const deck of decks) {
      if (String(toBigInt(deck.shipUid || 0)) === normalizedUid) deck.shipUid = 0;
    }
  }
}

function clearOperatorFromDecks(army, operatorUid, options = {}) {
  const normalizedUid = String(toBigInt(operatorUid));
  for (const [, decks] of deckSetEntries(army, options.deckType)) {
    for (const deck of decks) {
      if (String(toBigInt(deck.operatorUid || 0)) === normalizedUid) deck.operatorUid = 0;
    }
  }
}

function deckSetEntries(army, deckType = null) {
  if (deckType == null) return Object.entries(army.deckSets || {});
  const type = normalizeDeckType(deckType);
  return [[String(type), getDeckSet(army, type)]];
}

function normalizeDeckType(deckType) {
  const type = Number(deckType);
  return Number.isInteger(type) && type >= 0 && type <= 10 ? type : 1;
}

function normalizeDeckIndex(index) {
  const numeric = Number(index);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : 0;
}

function normalizeSlot(slot, length) {
  const numeric = Number(slot);
  return Number.isInteger(numeric) && numeric >= 0 && numeric < length ? numeric : 0;
}

function defaultDeckCount(deckType) {
  if (deckType === 1 || deckType === 2 || deckType === 3 || deckType === 5 || deckType === 6 || deckType === 8) return 1;
  if (deckType === 4) return 3;
  return 0;
}

function allocateUnitUid(user) {
  ensureArmy(user);
  let next = toBigInt(user.nextUnitUid, DEFAULT_NEXT_UNIT_UID);
  while (
    user.army.units[next.toString()] ||
    user.army.ships[next.toString()] ||
    user.army.trophies[next.toString()] ||
    user.army.operators[next.toString()]
  ) {
    next += 1n;
  }
  user.nextUnitUid = String(next + 1n);
  return next;
}

function normalizeSkillLevels(values) {
  return normalizeFixedArray(values, 5, 1).map((value) => Math.max(1, Number(value) || 1));
}

function normalizeFixedArray(values, length, fallback) {
  const result = Array.isArray(values) ? values.slice(0, length) : [];
  while (result.length < length) result.push(fallback);
  return result;
}

function normalizeShipCommandModules(values) {
  const modules = Array.isArray(values) && values.length ? values.slice(0, 2) : [null, null];
  while (modules.length < 2) modules.push(null);
  return modules.map((module, moduleIndex) => {
    const source = module && typeof module === "object" ? module : {};
    const slots = Array.isArray(source.slots) && source.slots.length ? source.slots.slice(0, 2) : [null, null];
    while (slots.length < 2) slots.push(null);
    return {
      slots: slots.map((slot, slotIndex) => normalizeShipCommandSlot(slot, moduleIndex, slotIndex)),
    };
  });
}

function normalizeShipCommandSlot(value, moduleIndex = 0, slotIndex = 0) {
  const slot = value && typeof value === "object" ? value : {};
  const defaultStats = ["NST_HP", "NST_ATK", "NST_DEF", "NST_SKILL_COOL_TIME_REDUCE_RATE"];
  return {
    targetStyleType: Array.isArray(slot.targetStyleType) ? slot.targetStyleType : Array.isArray(slot.styleTypes) ? slot.styleTypes : [],
    targetRoleType: Array.isArray(slot.targetRoleType) ? slot.targetRoleType : Array.isArray(slot.roleTypes) ? slot.roleTypes : [],
    statType: slot.statType != null ? slot.statType : defaultStats[(moduleIndex * 2 + slotIndex) % defaultStats.length],
    statValue: Number(slot.statValue != null ? slot.statValue : slot.value != null ? slot.value : 5 + moduleIndex + slotIndex) || 0,
    isLock: Boolean(slot.isLock || slot.locked),
  };
}

module.exports = {
  ensureArmy,
  getArmyUnits,
  getArmyShips,
  getArmyTrophies,
  getArmyOperators,
  getArmyDeckSets,
  ensureDefaultLineup,
  buildPlayerDeckForGameLoad,
  grantUnit,
  grantOperator,
  grantUnitFromPiece,
  getPieceRequirement,
  createUnitData,
  setUnitSkin,
  getArmyUnitByUid,
  getArmyOperatorByUid,
  getUnitMaxLevel,
  addUnitExp,
  setUnitLevel,
  enhanceUnitStats,
  getNextUnitLimitBreakRank,
  limitBreakUnit,
  upgradeUnitSkill,
  tacticUpdateUnit,
  reactorLevelUpUnit,
  permanentlyContractUnit,
  rearmUnit,
  setShipLevel,
  upgradeShip,
  limitBreakShip,
  setUnitLock,
  setUnitFavorite,
  setOperatorLock,
  levelOperator,
  addOperatorExp,
  enhanceOperator,
  removeArmyUnitUids,
  removeOperatorUids,
  ensureDeck,
  swapDeckUnits,
  setDeckLeader,
  unlockDeck,
  setDeckUnit,
  autoSetDeck,
  setDeckShip,
  setDeckOperator,
  updateDeckName,
  normalizeShipCommandModules,
};
