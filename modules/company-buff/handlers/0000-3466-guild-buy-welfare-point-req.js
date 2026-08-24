"use strict";

const { createCompanyBuffHandlers, PACKETS } = require("..");

module.exports = createCompanyBuffHandlers().find((handler) => handler.packetId === PACKETS.WELFARE_POINT_REQ);
