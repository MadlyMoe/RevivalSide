const { readByte } = require("../modules/packet-codec");

module.exports = {
  packetId: 607,
  name: "INFORM_MY_LOADING_PROGRESS_REQ",
  handle(ctx, socket, packet) {
    const progress = readProgress(ctx, packet);
    if (progress == null) return true;
    const replay = socket && socket.session && socket.session.gameReplay;
    if (replay) replay.loadingProgress = progress;
    if (typeof ctx.onClientLoadingProgress === "function") ctx.onClientLoadingProgress(socket, progress);
    if (ctx.config.VERBOSE_CAPTURE_LOGS) {
      console.log(`[capture-game] INFORM_MY_LOADING_PROGRESS_REQ progress=${progress}; official flow sends no direct ACK`);
    }
    return true;
  },
};

function readProgress(ctx, packet) {
  try {
    const payload = packet && packet.payload ? ctx.decryptCopy(packet.payload) : Buffer.alloc(0);
    const read = readByte(payload, 0);
    return read.offset === payload.length && read.value <= 100 ? read.value : null;
  } catch (_) {
    return null;
  }
}
