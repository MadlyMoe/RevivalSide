"use strict";

const { createCompanyBuffHandlers, PACKETS } = require("..");

module.exports = createCompanyBuffHandlers().find((handler) => handler.packetId === PACKETS.INVITE_REQ);
