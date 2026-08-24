module.exports = {
  packetId: 453,
  name: "GREETING_MESSAGE_REQ",
  handle(ctx, socket, packet) {
    const user = socket && socket.session && socket.session.user;
    ctx.sendGameResponse(
      socket,
      packet,
      ctx.constants.GREETING_MESSAGE_ACK,
      ctx.buildGreetingMessageAckPayload(user && user.friendIntro || ""),
      "greeting-message"
    );
    return true;
  },
};
