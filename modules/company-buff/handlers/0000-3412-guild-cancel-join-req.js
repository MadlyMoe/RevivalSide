"use strict";

const { createCompanyBuffHandlers, PACKETS } = require("..");

module.exports = createCompanyBuffHandlers().find((handler) => handler.packetId === PACKETS.CANCEL_JOIN_REQ);
