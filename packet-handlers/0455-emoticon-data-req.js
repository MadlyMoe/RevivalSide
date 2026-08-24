const { handleEmoticonData } = require("../modules/community");

module.exports = {
  packetId: 455,
  name: "EMOTICON_DATA_REQ",
  handle: handleEmoticonData,
};
