const { writeSignedVarInt, writeSignedVarLong, readSignedVarInt, readSignedVarLong, toBigInt } = require("../../packet-codec");
const { getSkinTemplet, getUnitTemplet } = require("../../game-data");
const { getSkinIds } = require("../../inventory");
const { getArmyUnitByUid, setUnitSkin } = require("../../unit");

const NEC_OK = 0;
const NEC_FAIL_UNIT_NOT_EXIST = 133;
const NEC_FAIL_SKIN_NOT_OWNED = 274;
const NEC_FAIL_SKIN_UNIT_NOT_MATCH = 275;
const NEC_FAIL_UNIT_IS_SEIZED = 20316;
const NEC_FAIL_INVALID_REQUEST = 20191;

module.exports = {
  packetId: 1418,
  name: "SET_UNIT_SKIN_REQ",
  handle(ctx, socket, packet) {
    const user = (socket.session && socket.session.user) || ctx.createEphemeralUser();
    if (socket.session) socket.session.user = user;
    const request = decode(ctx, packet.payload);
    const result = setOwnedUnitSkin(user, request);
    console.log(`[skin] error=${result.errorCode} unitUID=${request.unitUID} skinID=${request.skinID}`);
    ctx.sendGameResponse(
      socket,
      packet,
      1419,
      Buffer.concat([
        writeSignedVarInt(result.errorCode),
        writeSignedVarLong(toBigInt(request.unitUID || 0)),
        writeSignedVarInt(Number(request.skinID || 0) || 0),
      ]),
      "set-unit-skin"
    );
    if (result.changed) {
      if (typeof ctx.invalidateJoinLobbyAckPayloadCache === "function") ctx.invalidateJoinLobbyAckPayloadCache("unit-skin");
      if (ctx.config.USE_LOCAL_USER_DB) ctx.saveUserDb();
    }
    return true;
  },
};

function setOwnedUnitSkin(user, request = {}) {
  if (!request.valid) return { errorCode: NEC_FAIL_INVALID_REQUEST, changed: false };
  const unit = getArmyUnitByUid(user, request.unitUID);
  const unitTemplet = getUnitTemplet(unit && unit.unitId);
  if (!unit || !unitTemplet || String(unitTemplet.m_NKM_UNIT_TYPE || "") !== "NUT_NORMAL") {
    return { errorCode: NEC_FAIL_UNIT_NOT_EXIST, changed: false };
  }
  const skinID = Number(request.skinID || 0) || 0;
  if (skinID !== 0) {
    if (unit.isSeized) return { errorCode: NEC_FAIL_UNIT_IS_SEIZED, changed: false };
    if (!getSkinIds(user).includes(skinID)) return { errorCode: NEC_FAIL_SKIN_NOT_OWNED, changed: false };
    const skin = getSkinTemplet(skinID);
    if (!skin || !isSkinForUnit(unitTemplet, skin)) return { errorCode: NEC_FAIL_SKIN_UNIT_NOT_MATCH, changed: false };
  }
  if (Number(unit.skinId || 0) === skinID) return { errorCode: NEC_OK, changed: false };
  setUnitSkin(user, request.unitUID, skinID);
  return { errorCode: NEC_OK, changed: true };
}

function isSkinForUnit(unitTemplet, skin) {
  const skinUnitID = Number(skin && skin.m_SkinEquipUnitID || 0);
  if (!skinUnitID || String(unitTemplet.m_NKM_UNIT_STYLE_TYPE || "") === "NUST_TRAINER") return false;
  if (Number(unitTemplet.m_UnitID) === skinUnitID) return true;
  const skinUnitTemplet = getUnitTemplet(skinUnitID);
  if (!skinUnitTemplet || String(skinUnitTemplet.m_NKM_UNIT_STYLE_TYPE || "") === "NUST_TRAINER") return false;
  const unitBaseID = Number(unitTemplet.m_BaseUnitID || unitTemplet.m_UnitID || 0);
  const skinBaseID = Number(skinUnitTemplet.m_BaseUnitID || skinUnitTemplet.m_UnitID || 0);
  return unitBaseID > 0 && unitBaseID === skinBaseID;
}

function decode(ctx, encryptedPayload) {
  try {
    const payload = ctx.decryptCopy(encryptedPayload);
    const unit = readSignedVarLong(payload, 0);
    const skin = readSignedVarInt(payload, unit.offset);
    return { valid: skin.offset === payload.length, unitUID: unit.value, skinID: skin.value };
  } catch (err) {
    console.log(`[skin] request decode failed: ${err.message}`);
    return { valid: false, unitUID: 0n, skinID: 0 };
  }
}
