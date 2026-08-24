"use strict";

const { createCompanyBuffHandlers, PACKETS } = require("..");

module.exports = createCompanyBuffHandlers().find((handler) => handler.packetId === PACKETS.CANCEL_INVITE_REQ);
