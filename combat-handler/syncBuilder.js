// Binary packet builders for combat-layer responses.
//
// This module owns the combat payload shapes (817/822 and future 811 helpers).
// cs-listener.js should decide when to send packets; it should not assemble
// battle sync bodies directly.

function buildRespawnAck(data = {}) {
  return buildGameRespawnAckPayload(data.unitUID, data.assistUnit, data.errorCode);
}

function buildGameRespawnAckPayload(unitUID, assistUnit, errorCode = 0) {
  return Buffer.concat([writeSignedVarInt(errorCode), writeSignedVarLong(BigInt(unitUID || 0)), writeBool(Boolean(assistUnit))]);
}

function buildGameEndNot(data = {}) {
  const result = data.resultPayload;
  return Buffer.isBuffer(result) ? Buffer.from(result) : Buffer.alloc(0);
}

function buildGameSync(data = {}, options = {}) {
  const battleState = data.battleState || null;
  if (battleState) {
    const delta = data.delta == null ? 0.5 : Number(data.delta);
    battleState.gameTime = Number(battleState.gameTime || 0) + delta;
    battleState.absoluteGameTime = Number(battleState.absoluteGameTime || battleState.gameTime) + delta;
    battleState.remainGameTime = Math.max(0, Number(battleState.remainGameTime == null ? 180 : battleState.remainGameTime) - delta);
    if (!data.skipSimulation && typeof options.continueBattleStateUnits === "function") {
      options.continueBattleStateUnits(battleState, delta);
    }
    data = {
      ...data,
      gameTime: battleState.gameTime,
      absoluteGameTime: battleState.absoluteGameTime,
      remainGameTime: battleState.remainGameTime,
      respawnCostA1: battleState.respawnCostA1,
      respawnCostB1: battleState.respawnCostB1,
      units: data.units || battleState.units || [],
      dieUnits:
        data.dieUnits ||
        (battleState.pendingDieUnitUIDs && battleState.pendingDieUnitUIDs.length
          ? [battleState.pendingDieUnitUIDs.splice(0)]
          : []),
      decks:
        data.decks ||
        (battleState.pendingDeckSyncs && battleState.pendingDeckSyncs.length ? battleState.pendingDeckSyncs.splice(0) : []),
      gameStates:
        data.gameStates ||
        (battleState.pendingGameStates && battleState.pendingGameStates.length ? battleState.pendingGameStates.splice(0) : []),
      dungeonEvents:
        data.dungeonEvents ||
        (battleState.pendingDungeonEvents && battleState.pendingDungeonEvents.length
          ? battleState.pendingDungeonEvents.splice(0)
          : []),
    };
  }

  const baseEntries = Array.isArray(data.baseEntries)
    ? data.baseEntries
    : [
        buildGameSyncDataBase({
          gameTime: data.gameTime || 0,
          remainGameTime: data.remainGameTime == null ? 180 : data.remainGameTime,
          respawnCostA1: data.respawnCostA1 == null ? 10 : data.respawnCostA1,
          respawnCostB1: data.respawnCostB1 == null ? 10 : data.respawnCostB1,
          respawnCostAssistA1: data.respawnCostAssistA1 || 0,
          respawnCostAssistB1: data.respawnCostAssistB1 || 0,
          usedRespawnCostA1: data.usedRespawnCostA1 || 0,
          usedRespawnCostB1: data.usedRespawnCostB1 || 0,
          gameSpeedType: resolveControlValue(data, "gameSpeedType", 0),
          autoSkillTypeA: resolveControlValue(data, "autoSkillType", 1),
          autoSkillTypeB: resolveControlValue(data, "autoSkillTypeB", 0),
          dieUnits: data.dieUnits || [],
          units: data.units || [],
          decks: data.decks || [],
          gameStates: data.gameStates || [],
          dungeonEvents: data.dungeonEvents || [],
        }),
      ];
  const payload = buildNptGameSyncDataPack(data.gameTime || 0, data.absoluteGameTime || data.gameTime || 0, baseEntries, false);
  if (battleState) {
    for (const unit of battleState.units || []) {
      if (unit) unit.respawn = false;
    }
  }
  return payload;
}

function buildInitialBattleSync(replay, options = {}) {
  const game = replay.dynamicGame || {};
  const battleState = replay.battleState || null;
  if (!battleState) {
    const gameTime = Number(replay.syntheticGameTime || 4);
    return buildGameSync({
      gameTime,
      absoluteGameTime: gameTime,
      dynamicGame: game,
      gameSpeedType: replay.gameSpeedType,
      autoSkillType: replay.autoSkillType,
    }, options);
  }
  game.initialUnitsSent = true;
  // Stage units map into 822 here. They must reference gameUnitUIDs that already
  // exist in the captured 804 NKMGameData template.
  const payload = buildGameSync(
    {
      gameTime: battleState.gameTime,
      absoluteGameTime: battleState.absoluteGameTime,
      remainGameTime: battleState.remainGameTime,
      dynamicGame: game,
      gameSpeedType: replay.gameSpeedType,
      autoSkillType: replay.autoSkillType,
      units: battleState.units,
      gameStates: [battleState.gameState],
    },
    options
  );
  for (const unit of battleState.units) unit.respawn = false;
  return payload;
}

function buildSyntheticGameSyncPayload(gameTime) {
  return Buffer.concat([
    writeFloatLE(gameTime),
    writeFloatLE(gameTime),
    writeNullableObject(writeVarInt(0)),
    writeBool(false),
  ]);
}

function buildNptGameSyncDataPack(gameTime, absoluteGameTime, baseEntries, simulationGame) {
  return Buffer.concat([
    writeFloatLE(gameTime),
    writeFloatLE(absoluteGameTime),
    writeNullableObject(writeObjectList(baseEntries.map(writeNullableObject))),
    writeBool(Boolean(simulationGame)),
  ]);
}

function buildGameSyncDataBase(entry) {
  return Buffer.concat([
    writeHalfFloat(entry.gameTime || 0),
    writeHalfFloat(entry.remainGameTime == null ? 180 : entry.remainGameTime),
    writeHalfFloat(entry.shipDamage || 0),
    writeHalfFloat(entry.respawnCostA1 == null ? 10 : entry.respawnCostA1),
    writeHalfFloat(entry.respawnCostB1 == null ? 10 : entry.respawnCostB1),
    writeHalfFloat(entry.respawnCostAssistA1 || 0),
    writeHalfFloat(entry.respawnCostAssistB1 || 0),
    writeHalfFloat(entry.usedRespawnCostA1 || 0),
    writeHalfFloat(entry.usedRespawnCostB1 || 0),
    writeSignedVarInt(clampControlEnum(entry.gameSpeedType, 0, 5, 0)),
    writeSignedVarInt(clampControlEnum(entry.autoSkillTypeA, 0, 1, 1)),
    writeSignedVarInt(clampControlEnum(entry.autoSkillTypeB, 0, 1, 0)),
    writeObjectList((entry.dieUnits || []).map((die) => writeNullableObject(buildGameSyncDataDieUnit(die)))),
    writeObjectList((entry.units || []).map((unit) => writeNullableObject(buildGameSyncDataUnit(unit)))),
    writeObjectList([]), // NKMGameSyncDataSimple_Unit
    writeObjectList([]), // NKMGameSyncData_ShipSkill
    writeObjectList((entry.decks || []).map((deck) => writeNullableObject(buildGameSyncDataDeck(deck)))),
    writeObjectList([]), // NKMGameSyncData_DeckAssist
    writeObjectList((entry.gameStates || []).map((state) => writeNullableObject(buildGameSyncDataGameState(state)))),
    writeObjectList((entry.dungeonEvents || []).map((event) => writeNullableObject(buildGameSyncDataDungeonEvent(event)))),
    writeObjectList([]), // NKMGameSyncData_GameEvent
    writeObjectList([]), // NKMGameSyncData_KillLog
    entry.gamePoint == null ? writeNullObject() : writeNullableObject(writeSignedVarInt(entry.gamePoint)),
  ]);
}

function resolveControlValue(data, key, fallback) {
  if (data && data[key] != null) return data[key];
  const dynamicGame = data && data.dynamicGame && typeof data.dynamicGame === "object" ? data.dynamicGame : null;
  if (dynamicGame && dynamicGame[key] != null) return dynamicGame[key];
  const battleState = data && data.battleState && typeof data.battleState === "object" ? data.battleState : null;
  if (battleState && battleState[key] != null) return battleState[key];
  return fallback;
}

function clampControlEnum(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric | 0));
}

function buildGameSyncDataUnit(unit) {
  return writeNullableObject(buildNkmUnitSyncData(unit));
}

function buildNkmUnitSyncData(unit) {
  const seed = unit.seed == null ? 51 : unit.seed;
  const encryptedHp = Math.max(0, Number(unit.hp || 0)) + seed;
  return Buffer.concat([
    writeByte(seed),
    writeSignedVarInt(unit.playState == null ? 1 : unit.playState),
    writeObjectList([]), // m_listNKM_UNIT_EVENT_MARK
    writeBool(Boolean(unit.respawn)),
    writeBool(false),
    writeSignedVarInt(unit.gameUnitUID || 0),
    writeSignedVarInt(unit.targetUID || 0),
    writeSignedVarInt(unit.subTargetUID || 0),
    writeFloatLE(encryptedHp),
    writeFloatLE(unit.x || 0),
    writeFloatLE(unit.z || 0),
    writeFloatLE(unit.jumpY || 0),
    writeVarInt(floatToHalf(unit.speedX || 0)),
    writeVarInt(floatToHalf(unit.speedY || 0)),
    writeVarInt(floatToHalf(unit.speedZ || 0)),
    writeBool(unit.right !== false),
    writeByte(unit.stateId || 0),
    writeSByte(unit.stateChangeCount || 0),
    writeBool(Boolean(unit.damageSpeedXNegative)),
    writeBool(false),
    writeVarInt(floatToHalf(unit.damageSpeedX || 0)),
    writeVarInt(floatToHalf(unit.damageSpeedZ || 0)),
    writeVarInt(floatToHalf(unit.damageSpeedJumpY || 0)),
    writeVarInt(floatToHalf(unit.damageSpeedKeepTimeX || 0)),
    writeVarInt(floatToHalf(unit.damageSpeedKeepTimeZ || 0)),
    writeVarInt(floatToHalf(unit.damageSpeedKeepTimeJumpY || 0)),
    writeVarInt(floatToHalf(unit.skillCoolTime || 0)),
    writeVarInt(floatToHalf(unit.hyperSkillCoolTime || 0)),
    writeSignedVarInt(0),
    writeObjectList([]), // m_listDamageData
    writeObjectMapShort([]), // m_dicBuffData
    writeObjectList([]), // m_listStatusTimeData
    writeObjectList([]), // m_listInvokedTrigger
    writeStringIntMap([]), // m_dicEventVariables
    writeObjectList([]), // m_listUpdatedReaction
    writeFloatLE(unit.savedPosX || unit.x || 0),
    writeFloatLE(unit.savedPosY || 0),
  ]);
}

function buildGameSyncDataDieUnit(dieUnits) {
  const values = Array.isArray(dieUnits) ? dieUnits : [dieUnits];
  return Buffer.concat([writeVarInt(values.length), ...values.map(writeSignedVarInt)]);
}

function buildGameSyncDataDeck(deck) {
  return Buffer.concat([
    writeSignedVarInt(deck.team == null ? 1 : deck.team),
    writeSByte(deck.unitDeckIndex == null ? -1 : deck.unitDeckIndex),
    writeSignedVarLong(deck.unitDeckUID == null ? -1n : BigInt(deck.unitDeckUID)),
    writeSignedVarLong(deck.deckUsedAddUnitUID == null ? -1n : BigInt(deck.deckUsedAddUnitUID)),
    writeSByte(deck.deckUsedRemoveIndex == null ? -1 : deck.deckUsedRemoveIndex),
    writeSignedVarLong(deck.deckTombAddUnitUID == null ? -1n : BigInt(deck.deckTombAddUnitUID)),
    writeSByte(deck.autoRespawnIndex == null ? -1 : deck.autoRespawnIndex),
    writeSignedVarLong(deck.nextDeckUnitUID == null ? -1n : BigInt(deck.nextDeckUnitUID)),
  ]);
}

function buildGameSyncDataGameState(state) {
  return Buffer.concat([
    writeSignedVarInt(state.state == null ? 3 : state.state),
    writeSignedVarInt(state.winTeam || 0),
    writeSignedVarInt(state.waveId || 1),
  ]);
}

function buildGameSyncDataDungeonEvent(event) {
  return Buffer.concat([
    writeSignedVarInt(event.actionType == null ? 0 : event.actionType),
    writeSignedVarInt(event.eventId == null ? 0 : event.eventId),
    writeSignedVarInt(event.actionValue == null ? 0 : event.actionValue),
    writeString(event.actionString || ""),
    writeBool(Boolean(event.pause)),
    writeSignedVarInt(event.team == null ? 0 : event.team),
  ]);
}

function writeString(value) {
  if (value == null) return writeSignedVarInt(-1);
  const bytes = Buffer.from(String(value), "utf8");
  return Buffer.concat([writeSignedVarInt(bytes.length), bytes]);
}

function writeObjectList(values) {
  return Buffer.concat([writeVarInt(values.length), ...values]);
}

function writeObjectMapShort(entries) {
  return Buffer.concat([
    writeVarInt(entries.length),
    ...entries.flatMap(([key, payload]) => [writeSignedVarInt(key), writeNullableObject(payload)]),
  ]);
}

function writeStringIntMap(entries) {
  return Buffer.concat([
    writeVarInt(entries.length),
    ...entries.flatMap(([key, value]) => [writeString(key), writeSignedVarInt(value)]),
  ]);
}

function writeNullableObject(payload) {
  return Buffer.concat([writeBool(true), payload]);
}

function writeNullObject() {
  return writeBool(false);
}

function writeBool(value) {
  return Buffer.from([value ? 1 : 0]);
}

function writeByte(value) {
  return Buffer.from([Number(value) & 0xff]);
}

function writeSByte(value) {
  return Buffer.from([Number(value) & 0xff]);
}

function writeFloatLE(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeFloatLE(Number(value), 0);
  return buffer;
}

function writeHalfFloat(value) {
  return writeVarInt(Math.max(0, Math.trunc(Number(value || 0) * 100)));
}

function floatToHalf(value) {
  const f = Number(value || 0);
  if (!Number.isFinite(f) || f === 0) return 0;
  const floatView = new Float32Array(1);
  const intView = new Uint32Array(floatView.buffer);
  floatView[0] = Math.max(-50000, Math.min(50000, f));
  const bits = intView[0];
  const sign = (bits >>> 16) & 0x8000;
  let exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  let mantissa = bits & 0x7fffff;
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    mantissa = (mantissa | 0x800000) >>> (1 - exponent);
    return sign | ((mantissa + 0x1000) >>> 13);
  }
  if (exponent >= 31) return sign | 0x7c00;
  return sign | (exponent << 10) | ((mantissa + 0x1000) >>> 13);
}

function writeVarInt(value) {
  const bytes = [];
  let current = Number(value) >>> 0;
  while (current > 0x7f) {
    bytes.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }
  bytes.push(current);
  return Buffer.from(bytes);
}

function writeSignedVarInt(value) {
  return writeVarInt(zigZagEncode32(value));
}

function writeVarLong(value) {
  let current = zigZagEncode64(BigInt(value));
  const bytes = [];
  while (current > 0x7fn) {
    bytes.push(Number((current & 0x7fn) | 0x80n));
    current >>= 7n;
  }
  bytes.push(Number(current));
  return Buffer.from(bytes);
}

function writeSignedVarLong(value) {
  return writeVarLong(value);
}

function zigZagEncode32(value) {
  return ((value << 1) ^ (value >> 31)) >>> 0;
}

function zigZagEncode64(value) {
  return (value << 1n) ^ (value >> 63n);
}

module.exports = {
  buildRespawnAck,
  buildGameRespawnAckPayload,
  buildGameEndNot,
  buildGameSync,
  buildInitialBattleSync,
  buildSyntheticGameSyncPayload,
  buildNptGameSyncDataPack,
  buildGameSyncDataBase,
  buildGameSyncDataUnit,
  buildNkmUnitSyncData,
  buildGameSyncDataDieUnit,
  buildGameSyncDataDeck,
  buildGameSyncDataGameState,
  buildGameSyncDataDungeonEvent,
  writeSignedVarLong,
};
