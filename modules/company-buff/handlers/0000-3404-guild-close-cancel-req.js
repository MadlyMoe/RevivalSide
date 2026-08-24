"use strict";

const { createCompanyBuffHandlers, PACKETS } = require("..");

module.exports = createCompanyBuffHandlers().find((handler) => handler.packetId === PACKETS.CLOSE_CANCEL_REQ);
