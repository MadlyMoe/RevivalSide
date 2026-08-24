"use strict";

const { createDraftPvpVoteHandlers, createPvpCastingVoteHandlers } = require("..");

module.exports = [...createPvpCastingVoteHandlers(), ...createDraftPvpVoteHandlers()];
