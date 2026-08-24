const { handleFriendList } = require("../modules/community");

module.exports = {
  packetId: 400,
  name: "FRIEND_LIST_REQ",
  handle: handleFriendList,
};
