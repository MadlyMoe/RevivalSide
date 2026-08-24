"use strict";

const {
  writeNullableObject,
  writeSignedVarInt,
} = require("../packet-codec");

function buildDefenceGameEndNotPayload(gameEndData, defenceTempletId, gameScore, bestScore) {
  return Buffer.concat([
    writeNullableObject(gameEndData),
    writeNullableObject(Buffer.concat([
      writeSignedVarInt(Number(defenceTempletId) || 0),
      writeSignedVarInt(Math.max(0, Number(gameScore) || 0)),
      writeSignedVarInt(Math.max(0, Number(bestScore) || 0)),
    ])),
  ]);
}

module.exports = { buildDefenceGameEndNotPayload };
