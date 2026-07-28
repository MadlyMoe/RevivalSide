const {
  writeString,
  writeBool,
  writeByte,
  writeSByte,
  writeInt64LE,
  writeSignedVarInt,
  writeSignedVarLong,
  writeNullableObject,
  writeNullObject,
  writeObjectList,
  writeNullableObjectList,
  writeIntList,
  writeLongArray,
  buildUnitData,
  buildOperatorData,
  buildEquipItemData,
  buildDeckIndexData,
  buildDeckData,
  buildRewardData,
  buildShipCmdModuleData,
  buildShipModuleCandidateData,
  dateTimeBinaryNow,
  readSignedVarInt,
  readSignedVarLong,
  readSignedVarLongList,
  readBool,
  readByte,
  readSByte,
  readString,
  toBigInt,
} = require("../packet-codec");
const {
  ensureArmy,
  getArmyUnits,
  getArmyShips,
  getArmyOperators,
  grantUnit,
  grantOperator,
  ensureDeck,
  normalizeShipCommandModules,
} = require("../unit");
const { getPlayableShipIds, getPlayableOperatorIds } = require("../game-data");
const { getEquipItems } = require("../equipment");
const { ensureAccountProgress } = require("../account-progression");

const PACKET_NAMES = Object.freeze({
  15: "WARFARE_FRIEND_LIST_REQ",
  1447: "SHIP_SLOT_LOCK_REQ",
  1449: "SHIP_SLOT_OPTION_CHANGE_REQ",
  1451: "SHIP_SLOT_OPTION_CONFIRM_REQ",
  1453: "SHIP_SLOT_FIRST_OPTION_REQ",
  1455: "SHIP_SLOT_OPTION_CANCEL_REQ",
  1459: "RECALL_OPERATOR_REQ",
  1662: "SUPPORT_UNIT_LIST_REQ",
  1664: "SET_MY_SUPPORT_UNIT_REQ",
  1666: "SET_DUNGEON_SUPPORT_UNIT_REQ",
  1668: "REMAIN_PASS_REWARD_REQ",
  2621: "UPDATE_DEFENCE_DECK_REQ",
  4117: "PRIVATE_PVP_LOBBY_SYNC_DECK_INDEX_REQ",
});

function createCombatRosterHandlers() {
  return Object.keys(PACKET_NAMES).map((packetIdText) => {
    const packetId = Number(packetIdText);
    return {
      packetId,
      name: PACKET_NAMES[packetId],
      handle(ctx, socket, packet) {
        const user = getSocketUser(ctx, socket);
        const request = decodeRequest(ctx, packetId, packet.payload);
        const response = buildResponse(ctx, user, packetId, request);
        console.log(`[roster:${PACKET_NAMES[packetId]}] ACK packetId=${response.packetId} ${response.log || ""}`.trim());
        sendRosterResponse(ctx, socket, packet, response);
        if (ctx.config.USE_LOCAL_USER_DB) ctx.saveUserDb();
        return true;
      },
    };
  });
}

function buildResponse(ctx, user, packetId, req) {
  switch (packetId) {
    case 15:
      return ack(16, Buffer.concat([writeSignedVarInt(0), writeNullableObjectList(buildWarfareSupporters(user)), writeNullableObjectList([])]), "friends=1");
    case 1410:
      return shipWithCost(1411, buildShip(user, req.shipID), `shipID=${req.shipID}`);
    case 1412:
      return shipWithCost(1413, levelShip(user, req.shipUID, req.nextLevel), `shipUID=${String(req.shipUID)} level=${req.nextLevel}`);
    case 1414:
      return shipWithCost(1415, upgradeShip(user, req.shipUID, req.nextShipID), `shipUID=${String(req.shipUID)} nextShipID=${req.nextShipID}`);
    case 1416:
      removeShips(user, req.removeShipUIDList);
      return ack(1417, Buffer.concat([writeSignedVarInt(0), writeLongArray(req.removeShipUIDList), writeNullableObjectList([])]), `removed=${req.removeShipUIDList.length}`);
    case 1424:
      return operatorLevelAck(user, req);
    case 1426:
      return operatorEnhanceAck(user, req);
    case 1428:
      return operatorLockAck(user, req);
    case 1430:
      removeOperators(user, req.removeUnitUIDList);
      return ack(1431, Buffer.concat([writeSignedVarInt(0), writeLongArray(req.removeUnitUIDList), writeNullableObjectList([])]), `removed=${req.removeUnitUIDList.length}`);
    case 1445:
      return limitBreakShipAck(user, req);
    case 1447:
      return shipWithCost(1448, lockShipModuleSlot(user, req), `shipUID=${String(req.shipUid)} module=${req.moduleId} slot=${req.slotId}`);
    case 1449:
      return shipModuleRollAck(user, req);
    case 1451:
      return shipModuleConfirmAck(user, req);
    case 1453:
      return shipModuleFirstOptionAck(user, req);
    case 1455:
      clearPendingShipModuleCandidate(user);
      return ack(1456, writeSignedVarInt(0), "candidate=cleared");
    case 1459:
      return operatorRecallAck(user, req);
    case 1463:
      removeOperators(user, req.extractUnitUids);
      return ack(1464, Buffer.concat([writeSignedVarInt(0), writeLongArray(req.extractUnitUids), writeNullableObjectList([]), writeNullableObjectList([])]), `extracted=${req.extractUnitUids.length}`);
    case 1662:
      return supportListAck(user);
    case 1664:
      return setMySupportAck(user, req.unitUid);
    case 1666:
      return setDungeonSupportAck(user, req.raw);
    case 1668:
      return ack(
        1669,
        Buffer.concat([writeSignedVarInt(0), writeSignedVarInt(0), writeNullableObject(buildRewardData({}))]),
        "reward=empty"
      );
    case 2621:
      return updateDefenceDeckAck(user, req.raw);
    case 4117:
      user.pvp = user.pvp && typeof user.pvp === "object" ? user.pvp : {};
      user.pvp.privateLobbyDeckIndex = req.deckIndex;
      return ack(4118, writeSignedVarInt(0), `deckType=${req.deckIndex.deckType} index=${req.deckIndex.index}`);
    default:
      return ack(packetId + 1, writeSignedVarInt(0));
  }
}

function shipWithCost(packetId, ship, log) {
  return ack(packetId, Buffer.concat([writeSignedVarInt(0), writeNullableObject(buildUnitData(ship)), writeNullableObjectList([])]), log);
}

function buildShip(user, shipID) {
  const shipIds = getPlayableShipIds();
  const fallbackId = shipIds[0] || 0;
  const ship = grantUnit(user, Number(shipID) || fallbackId, { level: 1 });
  return ensureShipModules(ship || ensureShip(user, 0, fallbackId));
}

function ensureShip(user, shipUid = 0, fallbackShipId = 0) {
  const army = ensureArmy(user);
  const key = String(toBigInt(shipUid));
  const existing = key !== "0" ? army.ships[key] : null;
  if (existing) return ensureShipModules(existing);
  const first = Object.values(army.ships || {})[0];
  if (first) return ensureShipModules(first);
  const shipId = Number(fallbackShipId) || (getPlayableShipIds()[0] || 0);
  return ensureShipModules(grantUnit(user, shipId, { level: 1 }));
}

function levelShip(user, shipUid, nextLevel) {
  const ship = ensureShip(user, shipUid);
  ship.level = Math.max(Number(ship.level || 1), Number(nextLevel || 1));
  return ensureShipModules(ship);
}

function upgradeShip(user, shipUid, nextShipID) {
  const ship = ensureShip(user, shipUid, nextShipID);
  if (Number(nextShipID) > 0) ship.unitId = Number(nextShipID);
  ship.level = Math.max(Number(ship.level || 1), 1);
  return ensureShipModules(ship);
}

function limitBreakShipAck(user, req) {
  const ship = ensureShip(user, req.shipUid);
  ship.limitBreakLevel = Math.max(Number(ship.limitBreakLevel || 0), Math.min(10, Number(ship.limitBreakLevel || 0) + 1));
  removeShips(user, [req.consumeShipUid]);
  return ack(
    1446,
    Buffer.concat([
      writeSignedVarInt(0),
      writeNullableObject(buildUnitData(ensureShipModules(ship))),
      writeSignedVarLong(toBigInt(req.consumeShipUid || 0)),
      writeNullableObjectList([]),
    ]),
    `shipUID=${String(req.shipUid)} consume=${String(req.consumeShipUid)}`
  );
}

function removeShips(user, shipUids) {
  const army = ensureArmy(user);
  for (const uid of Array.isArray(shipUids) ? shipUids : []) {
    const key = String(toBigInt(uid));
    if (key === "0") continue;
    delete army.ships[key];
    for (const decks of Object.values(army.deckSets || {})) {
      for (const deck of decks) {
        if (String(toBigInt(deck.shipUid || 0)) === key) deck.shipUid = 0;
      }
    }
  }
}

function ensureShipModules(ship) {
  if (!ship) return ship;
  ship.shipCommandModules = normalizeShipCommandModules(ship.shipCommandModules || ship.shipModules || ship.ShipCommandModule);
  return ship;
}

function lockShipModuleSlot(user, req) {
  const ship = ensureShip(user, req.shipUid);
  const modules = ensureShipModules(ship).shipCommandModules;
  const moduleIndex = normalizeModuleIndex(req.moduleId, modules.length);
  const slotIndex = normalizeSlotIndex(req.slotId, 2);
  modules[moduleIndex].slots[slotIndex].isLock = Boolean(req.locked);
  return ship;
}

function shipModuleRollAck(user, req) {
  const ship = ensureShip(user, req.shipUid);
  const moduleIndex = normalizeModuleIndex(req.moduleId, ensureShipModules(ship).shipCommandModules.length);
  const candidate = rollShipModuleCandidate(ship, moduleIndex);
  user.pendingShipModuleCandidate = {
    shipUid: String(toBigInt(ship.unitUid)),
    moduleId: moduleIndex,
    module: candidate,
  };
  return ack(
    1450,
    Buffer.concat([
      writeSignedVarInt(0),
      writeNullableObject(buildUnitData(ship)),
      writeNullableObject(buildShipModuleCandidateData({ shipUid: ship.unitUid, moduleId: moduleIndex, slotCandidate: candidate })),
      writeNullableObjectList([]),
    ]),
    `shipUID=${String(ship.unitUid)} module=${moduleIndex}`
  );
}

function shipModuleConfirmAck(user, req) {
  const ship = ensureShip(user, req.shipUid);
  const moduleIndex = normalizeModuleIndex(req.moduleId, ensureShipModules(ship).shipCommandModules.length);
  const pending = user.pendingShipModuleCandidate;
  if (pending && String(toBigInt(pending.shipUid)) === String(toBigInt(ship.unitUid)) && Number(pending.moduleId) === moduleIndex) {
    ship.shipCommandModules[moduleIndex] = pending.module;
  }
  clearPendingShipModuleCandidate(user);
  return ack(1452, Buffer.concat([writeSignedVarInt(0), writeNullableObject(buildUnitData(ensureShipModules(ship)))]), `shipUID=${String(ship.unitUid)} module=${moduleIndex}`);
}

function shipModuleFirstOptionAck(user, req) {
  const ship = ensureShip(user, req.shipUid);
  const moduleIndex = normalizeModuleIndex(req.moduleId, ensureShipModules(ship).shipCommandModules.length);
  ship.shipCommandModules[moduleIndex] = rollShipModuleCandidate(ship, moduleIndex);
  return ack(1454, Buffer.concat([writeSignedVarInt(0), writeNullableObject(buildUnitData(ship))]), `shipUID=${String(ship.unitUid)} module=${moduleIndex}`);
}

function clearPendingShipModuleCandidate(user) {
  if (user && Object.prototype.hasOwnProperty.call(user, "pendingShipModuleCandidate")) delete user.pendingShipModuleCandidate;
}

function rollShipModuleCandidate(ship, moduleIndex) {
  const cursor = Number(ship.moduleRollCursor || 0);
  ship.moduleRollCursor = cursor + 1;
  const statTypes = ["NST_HP", "NST_ATK", "NST_DEF", "NST_ATTACK_SPEED_RATE", "NST_SKILL_COOL_TIME_REDUCE_RATE", "NST_DAMAGE_REDUCE_RATE"];
  return {
    slots: [0, 1].map((slotIndex) => ({
      targetStyleType: [],
      targetRoleType: [],
      statType: statTypes[(cursor + moduleIndex + slotIndex) % statTypes.length],
      statValue: 4 + ((cursor + moduleIndex + slotIndex) % 8),
      isLock: Boolean(
        ship.shipCommandModules &&
          ship.shipCommandModules[moduleIndex] &&
          ship.shipCommandModules[moduleIndex].slots &&
          ship.shipCommandModules[moduleIndex].slots[slotIndex] &&
          ship.shipCommandModules[moduleIndex].slots[slotIndex].isLock
      ),
    })),
  };
}

function operatorLevelAck(user, req) {
  const operator = ensureOperator(user, req.targetUnitUid);
  operator.level = Math.max(Number(operator.level || 1), Math.min(110, Number(operator.level || 1) + 1));
  return ack(1425, Buffer.concat([writeSignedVarInt(0), writeNullableObjectList([]), writeNullableObject(buildOperatorData(operator))]), `operatorUid=${String(operator.uid)} level=${operator.level}`);
}

function operatorEnhanceAck(user, req) {
  const army = ensureArmy(user);
  const operator = ensureOperator(user, req.targetUnitUid);
  if (req.transSkill && req.tokenItemId > 0) {
    operator.subSkill = operator.subSkill || { id: req.tokenItemId, level: 1, exp: 0 };
    operator.subSkill.id = req.tokenItemId;
  } else {
    operator.level = Math.max(Number(operator.level || 1), Math.min(110, Number(operator.level || 1) + 1));
  }
  if (toBigInt(req.sourceUnitUid) > 0n && String(toBigInt(req.sourceUnitUid)) !== String(toBigInt(operator.uid))) {
    delete army.operators[String(toBigInt(req.sourceUnitUid))];
  }
  return ack(
    1427,
    Buffer.concat([
      writeSignedVarInt(0),
      writeNullableObject(buildOperatorData(operator)),
      writeNullableObjectList([]),
      writeSignedVarLong(toBigInt(req.sourceUnitUid || 0)),
      writeBool(Boolean(req.transSkill)),
      writeSignedVarInt(Number(req.tokenItemId || 0)),
    ]),
    `operatorUid=${String(operator.uid)} source=${String(req.sourceUnitUid)}`
  );
}

function operatorLockAck(user, req) {
  const operator = ensureOperator(user, req.unitUID);
  operator.locked = Boolean(req.locked);
  return ack(1429, Buffer.concat([writeSignedVarInt(0), writeSignedVarLong(toBigInt(operator.uid)), writeBool(operator.locked)]), `operatorUid=${String(operator.uid)} locked=${operator.locked ? 1 : 0}`);
}

function operatorRecallAck(user, req) {
  const army = ensureArmy(user);
  const recalled = ensureOperator(user, req.recallOperatorUid);
  delete army.operators[String(toBigInt(recalled.uid))];
  const exchangeId = Number(req.exchangeOperatorId) || Number(recalled.id || 0) || (getPlayableOperatorIds()[0] || 0);
  const replacement = grantOperator(user, exchangeId, { subSkillId: Number(req.exchangeSubSkillId || 0) || undefined }) || ensureOperator(user, 0);
  const historyInfo = Buffer.concat([writeSignedVarInt(exchangeId), writeInt64LE(toBigInt(dateTimeBinaryNow()))]);
  return ack(
    1460,
    Buffer.concat([
      writeSignedVarInt(0),
      writeSignedVarLong(toBigInt(recalled.uid || 0)),
      writeNullableObject(buildOperatorData(replacement)),
      writeNullableObject(historyInfo),
    ]),
    `removed=${String(recalled.uid)} exchange=${exchangeId}`
  );
}

function ensureOperator(user, operatorUid = 0) {
  const army = ensureArmy(user);
  const key = String(toBigInt(operatorUid));
  const existing = key !== "0" ? army.operators[key] : null;
  if (existing) return existing;
  const first = Object.values(army.operators || {})[0];
  if (first) return first;
  return grantOperator(user, getPlayableOperatorIds()[0] || 0, { level: 1 });
}

function removeOperators(user, operatorUids) {
  const army = ensureArmy(user);
  for (const uid of Array.isArray(operatorUids) ? operatorUids : []) {
    const key = String(toBigInt(uid));
    if (key === "0") continue;
    delete army.operators[key];
    for (const decks of Object.values(army.deckSets || {})) {
      for (const deck of decks) {
        if (String(toBigInt(deck.operatorUid || 0)) === key) deck.operatorUid = 0;
      }
    }
  }
}

function supportListAck(user) {
  const supportUnit = ensureSupportUnit(user);
  const profiles = supportUnit ? [buildSupportUnitProfileData(user, supportUnit)] : [];
  return ack(1663, Buffer.concat([writeSignedVarInt(0), writeNullableObjectList(profiles)]), `supports=${profiles.length}`);
}

function setMySupportAck(user, unitUid) {
  const supportUnit = getUnitForSupport(user, unitUid) || ensureSupportUnit(user);
  user.support = user.support && typeof user.support === "object" ? user.support : {};
  user.support.mySupportUnitUid = supportUnit ? String(toBigInt(supportUnit.unitUid)) : "0";
  user.support.mySupportUnitUpdatedAt = new Date().toISOString();
  return ack(1665, Buffer.concat([writeSignedVarInt(0), writeNullableObject(buildSupportUnitData(user, supportUnit))]), `unitUid=${user.support.mySupportUnitUid}`);
}

function setDungeonSupportAck(user, rawRequestPayload) {
  user.support = user.support && typeof user.support === "object" ? user.support : {};
  if (rawRequestPayload && rawRequestPayload.length) {
    persistDungeonSupportSelection(user, rawRequestPayload);
    return ack(1667, Buffer.concat([writeSignedVarInt(0), rawRequestPayload]), "echo=raw");
  }
  const supportUnit = ensureSupportUnit(user);
  const payload = writeNullableObject(buildDungeonSupportData(user, supportUnit, { deckType: 1, index: 0 }));
  persistDungeonSupportSelection(user, payload);
  return ack(1667, Buffer.concat([writeSignedVarInt(0), payload]), "echo=generated");
}

function persistDungeonSupportSelection(user, rawRequestPayload) {
  user.support = user.support && typeof user.support === "object" ? user.support : {};
  const raw = Buffer.isBuffer(rawRequestPayload) ? rawRequestPayload : Buffer.from(rawRequestPayload || []);
  const parsed = decodeDungeonSupportSelection(raw);
  if (parsed.userUid === "0") {
    delete user.support.dungeonSupportRaw;
    delete user.support.dungeonSupportUserUid;
    delete user.support.dungeonSupportDeckIndex;
    user.support.dungeonSupportUpdatedAt = new Date().toISOString();
    return;
  }
  user.support.dungeonSupportRaw = raw.toString("base64");
  if (parsed.userUid) user.support.dungeonSupportUserUid = parsed.userUid;
  if (parsed.deckIndex) user.support.dungeonSupportDeckIndex = parsed.deckIndex;
  user.support.dungeonSupportUpdatedAt = new Date().toISOString();
}

function decodeDungeonSupportSelection(rawRequestPayload) {
  if (!rawRequestPayload || !rawRequestPayload.length) return { userUid: "", deckIndex: null };
  let objectOffset = 0;
  try {
    const present = readBool(rawRequestPayload, 0);
    if (!present.value && rawRequestPayload.length === present.offset) return { userUid: "0", deckIndex: null };
    if (present.value) objectOffset = present.offset;
  } catch (_) {
    objectOffset = 0;
  }

  try {
    const userUid = readSignedVarLong(rawRequestPayload, objectOffset);
    return {
      userUid: String(toBigInt(userUid.value || 0)),
      deckIndex: decodeDeckIndexFromTail(rawRequestPayload),
    };
  } catch (_) {
    if (objectOffset !== 0) {
      try {
        const userUid = readSignedVarLong(rawRequestPayload, 0);
        return {
          userUid: String(toBigInt(userUid.value || 0)),
          deckIndex: decodeDeckIndexFromTail(rawRequestPayload),
        };
      } catch (_) {
        return { userUid: "", deckIndex: null };
      }
    }
    return { userUid: "", deckIndex: null };
  }
}

function decodeDeckIndexFromTail(rawRequestPayload) {
  const start = Math.max(0, rawRequestPayload.length - 12);
  let nullDeckIndex = null;
  for (let offset = start; offset < rawRequestPayload.length; offset += 1) {
    try {
      const present = readBool(rawRequestPayload, offset);
      if (!present.value) {
        if (present.offset === rawRequestPayload.length) nullDeckIndex = { deckType: 0, index: 0 };
        continue;
      }
      const deckType = readSignedVarInt(rawRequestPayload, present.offset);
      const index = readByte(rawRequestPayload, deckType.offset);
      if (index.offset === rawRequestPayload.length) {
        return {
          deckType: Number(deckType.value || 0),
          index: Number(index.value || 0),
        };
      }
    } catch (_) {
      // Try the next possible tail offset.
    }
  }
  return nullDeckIndex;
}

function updateDefenceDeckAck(user, rawRequestPayload) {
  user.pvp = user.pvp && typeof user.pvp === "object" ? user.pvp : {};
  if (rawRequestPayload && rawRequestPayload.length) {
    user.pvp.defenceDeckRaw = rawRequestPayload.toString("base64");
    return ack(2622, Buffer.concat([writeSignedVarInt(0), rawRequestPayload]), "deck=raw");
  }
  const deck = ensureDeck(user, { deckType: 4, index: 0 });
  const payload = writeNullableObject(buildDeckData(deck));
  user.pvp.defenceDeckRaw = payload.toString("base64");
  return ack(2622, Buffer.concat([writeSignedVarInt(0), payload]), "deck=generated");
}

function ensureSupportUnit(user) {
  user.support = user.support && typeof user.support === "object" ? user.support : {};
  hydratePersistedDungeonSupportSelection(user);
  const saved = user.support.mySupportUnitUid;
  const unit = getUnitForSupport(user, saved) || getArmyUnits(user)[0] || null;
  if (unit) {
    user.support.mySupportUnitUid = String(toBigInt(unit.unitUid));
  } else if (saved != null && String(toBigInt(saved)) !== "0") {
    user.support.mySupportUnitUid = "0";
  }
  return unit;
}

function hydratePersistedDungeonSupportSelection(user) {
  const support = user && user.support && typeof user.support === "object" ? user.support : null;
  if (!support || !support.dungeonSupportRaw || support.dungeonSupportUserUid) return;
  try {
    const parsed = decodeDungeonSupportSelection(Buffer.from(String(support.dungeonSupportRaw), "base64"));
    if (parsed.userUid && parsed.userUid !== "0") support.dungeonSupportUserUid = parsed.userUid;
    if (parsed.deckIndex) support.dungeonSupportDeckIndex = parsed.deckIndex;
  } catch (_) {
    // Keep the legacy raw value; it can still be echoed back on the next selection.
  }
}

function getUnitForSupport(user, unitUid) {
  const army = ensureArmy(user);
  const key = String(toBigInt(unitUid));
  return key !== "0" ? army.units[key] || null : null;
}

function buildSupportUnitProfileData(user, unit) {
  return Buffer.concat([
    writeNullableObject(buildCommonProfileData(user)),
    writeNullableObject(buildGuildSimpleData(user)),
    writeNullableObject(buildSupportUnitData(user, unit)),
  ]);
}

function buildSupportUnitData(user, unit) {
  return Buffer.concat([
    writeSignedVarLong(toBigInt(user.userUid || 0)),
    writeNullableObject(buildAsyncUnitEquipData(user, unit)),
    writeSignedVarLong(toBigInt(user.support && user.support.usedCount ? user.support.usedCount : 0)),
  ]);
}

function buildDungeonSupportData(user, unit, deckIndex) {
  return Buffer.concat([
    writeSignedVarLong(toBigInt(user.userUid || 0)),
    writeNullableObject(buildAsyncUnitEquipData(user, unit)),
    writeNullableObject(buildDeckIndexData(deckIndex || { deckType: 1, index: 0 })),
  ]);
}

function buildAsyncUnitEquipData(user, unit) {
  const unitUid = unit ? String(toBigInt(unit.unitUid || 0)) : "0";
  const equips = unitUid === "0" ? [] : getEquipItems(user).filter((equip) => String(toBigInt(equip.ownerUnitUid || 0)) === unitUid);
  return Buffer.concat([
    writeNullableObject(buildAsyncUnitData(unit)),
    writeNullableObjectList(equips.map(buildEquipItemData)),
  ]);
}

function buildAsyncUnitData(unit) {
  const data = unit || {};
  return Buffer.concat([
    writeSignedVarLong(toBigInt(data.unitUid || 0)),
    writeSignedVarInt(Number(data.unitId || 0) || 0),
    writeSignedVarInt(Number(data.level || 1) || 1),
    writeSignedVarInt(Number(data.skinId || 0) || 0),
    writeSignedVarInt(Number(data.limitBreakLevel || 0) || 0),
    writeIntList(normalizeFixedArray(data.skillLevels, 5, 1)),
    writeIntList(normalizeFixedArray(data.statExp, 6, 0)),
    writeLongArray(normalizeFixedArray(data.equipItemUids, 4, 0)),
    writeNullableObjectList((data.shipCommandModules || data.shipModules || []).map(buildShipCmdModuleData)),
    writeSignedVarInt(Number(data.tacticLevel || 0) || 0),
    writeSignedVarInt(Number(data.reactorLevel || 0) || 0),
  ]);
}

function buildCommonProfileData(user) {
  user = ensureAccountProgress(user || {}) || {};
  return Buffer.concat([
    writeSignedVarLong(toBigInt(user.userUid || 0)),
    writeSignedVarLong(toBigInt(user.friendCode || 0)),
    writeString(user.nickname || "LocalAdmin"),
    writeSignedVarInt(Number(user.level || 1) || 1),
    writeSignedVarInt(Number(user.mainUnitId || 0) || 0),
    writeSignedVarInt(Number(user.mainUnitSkinId || 0) || 0),
    writeSignedVarInt(Number(user.frameId || 0) || 0),
    writeSignedVarInt(Number(user.mainUnitTacticLevel || 0) || 0),
    writeSignedVarInt(Number(user.titleId || 0) || 0),
  ]);
}

function buildGuildSimpleData(user) {
  return Buffer.concat([
    writeSignedVarLong(toBigInt(user.guildUid || 0)),
    writeString(user.guildName || ""),
    writeSignedVarLong(toBigInt(user.guildBadgeId || 0)),
  ]);
}

function buildWarfareSupporters(user) {
  const unit = ensureSupportUnit(user);
  if (!unit) return [];
  const deck = ensureDeck(user, { deckType: 1, index: 0 });
  const ship = ensureShip(user, deck.shipUid);
  const operator = ensureOperator(user, deck.operatorUid);
  const dummyDeck = Buffer.concat([
    writeSByte(Number(deck.leaderIndex != null ? deck.leaderIndex : 0)),
    writeNullableObject(buildDummyUnitData(ship)),
    writeNullableObject(buildDummyUnitData(operatorToDummyUnit(operator))),
    writeNullableObjectList(normalizeFixedArray(deck.unitUids, 8, 0).map((uid) => buildDummyUnitData(ensureArmy(user).units[String(toBigInt(uid))]))),
  ]);
  return [
    Buffer.concat([
      writeNullableObject(buildCommonProfileData(user)),
      writeNullableObject(dummyDeck),
      writeInt64LE(toBigInt(dateTimeBinaryNow())),
      writeInt64LE(0n),
      writeString(user.friendIntro || ""),
      writeNullableObject(buildGuildSimpleData(user)),
    ]),
  ];
}

function operatorToDummyUnit(operator) {
  if (!operator) return null;
  return {
    unitId: Number(operator.id || operator.unitId || 0),
    level: Number(operator.level || 1),
    skinId: 0,
    limitBreakLevel: 0,
    tacticLevel: 0,
    reactorLevel: 0,
  };
}

function buildDummyUnitData(unit) {
  const data = unit || {};
  return Buffer.concat([
    writeSignedVarInt(Number(data.unitId || data.id || 0) || 0),
    writeSignedVarInt(Number(data.level || 1) || 1),
    writeSignedVarInt(Number(data.skinId || 0) || 0),
    writeSignedVarInt(Number(data.limitBreakLevel || 0) || 0),
    writeSignedVarInt(Number(data.tacticLevel || 0) || 0),
    writeSignedVarInt(Number(data.reactorLevel || 0) || 0),
  ]);
}

function decodeRequest(ctx, packetId, encryptedPayload) {
  let payload = Buffer.alloc(0);
  try {
    payload = ctx.decryptCopy(encryptedPayload);
  } catch (_) {
    payload = Buffer.alloc(0);
  }
  const reader = createReader(payload);
  try {
    switch (packetId) {
      case 1410:
        return { shipID: reader.int() };
      case 1412:
        return { shipUID: reader.long(), nextLevel: reader.int() };
      case 1414:
        return { shipUID: reader.long(), nextShipID: reader.int() };
      case 1416:
        return { removeShipUIDList: reader.longList() };
      case 1424:
        return { targetUnitUid: reader.long() };
      case 1426:
        return { targetUnitUid: reader.long(), sourceUnitUid: reader.long(), tokenItemId: reader.int(), transSkill: reader.bool() };
      case 1428:
        return { unitUID: reader.long(), locked: reader.bool() };
      case 1430:
        return { removeUnitUIDList: reader.longList() };
      case 1445:
        return { shipUid: reader.long(), consumeShipUid: reader.long() };
      case 1447:
        return { shipUid: reader.long(), moduleId: reader.int(), slotId: reader.int(), locked: reader.bool() };
      case 1449:
      case 1451:
      case 1453:
        return { shipUid: reader.long(), moduleId: reader.int() };
      case 1459:
        return { recallOperatorUid: reader.long(), exchangeOperatorId: reader.int(), exchangeSubSkillId: reader.int() };
      case 1463:
        return { extractUnitUids: reader.longList() };
      case 1664:
        return { unitUid: reader.long() };
      case 1666:
      case 2621:
        return { raw: payload };
      case 4117:
        return { deckIndex: reader.deckIndex() };
      default:
        return {};
    }
  } catch (err) {
    console.log(`[roster:${PACKET_NAMES[packetId] || packetId}] request decode failed: ${err.message}`);
    return packetId === 1666 || packetId === 2621 ? { raw: payload } : {};
  }
}

function createReader(payload) {
  let offset = 0;
  return {
    int() {
      const read = readSignedVarInt(payload, offset);
      offset = read.offset;
      return read.value;
    },
    long() {
      const read = readSignedVarLong(payload, offset);
      offset = read.offset;
      return read.value;
    },
    longList() {
      const read = readSignedVarLongList(payload, offset);
      offset = read.offset;
      return read.value;
    },
    bool() {
      const read = readBool(payload, offset);
      offset = read.offset;
      return read.value;
    },
    byte() {
      const read = readByte(payload, offset);
      offset = read.offset;
      return read.value;
    },
    sbyte() {
      const read = readSByte(payload, offset);
      offset = read.offset;
      return read.value;
    },
    string() {
      const read = readString(payload, offset);
      offset = read.offset;
      return read.value;
    },
    deckIndex() {
      if (!this.bool()) return { deckType: 0, index: 0 };
      return { deckType: this.int(), index: this.byte() };
    },
  };
}

function getSocketUser(ctx, socket) {
  const user = (socket.session && socket.session.user) || ctx.createEphemeralUser();
  if (socket.session) socket.session.user = user;
  ensureArmy(user);
  return user;
}

function ack(packetId, payload, log = "") {
  return { packetId, payload, log };
}

function sendRosterResponse(ctx, socket, packet, response) {
  if (ctx && typeof ctx.sendGameResponse === "function") {
    ctx.sendGameResponse(socket, packet, response.packetId, response.payload, `roster-${response.packetId}`);
    return;
  }
  ctx.sendResponse(socket, packet.sequence, response.packetId, () =>
    ctx.buildEncryptedPacket(packet.sequence, response.packetId, response.payload)
  );
}

function normalizeFixedArray(values, length, fallback) {
  const result = Array.isArray(values) ? values.slice(0, length) : [];
  while (result.length < length) result.push(fallback);
  return result;
}

function normalizeModuleIndex(moduleId, length) {
  const numeric = Number(moduleId);
  if (Number.isInteger(numeric) && numeric >= 0 && numeric < length) return numeric;
  if (Number.isInteger(numeric) && numeric > 0 && numeric <= length) return numeric - 1;
  return 0;
}

function normalizeSlotIndex(slotId, length) {
  const numeric = Number(slotId);
  if (Number.isInteger(numeric) && numeric >= 0 && numeric < length) return numeric;
  if (Number.isInteger(numeric) && numeric > 0 && numeric <= length) return numeric - 1;
  return 0;
}

module.exports = {
  createCombatRosterHandlers,
  ensureSupportUnit,
  buildSupportUnitData,
  buildSupportUnitProfileData,
  buildDungeonSupportData,
};
