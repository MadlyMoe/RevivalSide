const net = require("net");

const HTTP_TIMEOUT_MS = 25_000;
const PROXY_ACCEPT_TIMEOUT_MS = 120_000;
const MAX_BUFFERED_WEBSOCKET_BYTES = 4 * 1024 * 1024;

function createPrivatePvpRelayClient(options = {}) {
  const relayUrl = normalizeRelayUrl(options.relayUrl, options.allowInsecureLoopback);
  const secret = String(options.secret || "");
  const hostId = String(options.hostId || "");
  const role = options.role === "host" ? "host" : options.role === "join" ? "join" : "off";
  const localGamePort = Number(options.localGamePort || 22000) || 22000;
  const logger = typeof options.logger === "function" ? options.logger : console.log;
  let stopped = false;
  let hostLoopPromise = null;
  const bridges = new Set();
  const localProxies = new Set();
  const requestControllers = new Set();

  if (relayUrl && secret.length < 32) throw new Error("CS_PVP_RELAY_SECRET must contain at least 32 characters");
  if (relayUrl && role === "host" && !/^[A-Za-z0-9_-]{8,80}$/.test(hostId)) {
    throw new Error("CS_PVP_RELAY_HOST_ID must be an 8-80 character identifier");
  }

  async function request(pathname, init = {}) {
    const controller = new AbortController();
    requestControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), Number(init.timeoutMs || HTTP_TIMEOUT_MS));
    try {
      const response = await fetch(new URL(pathname, relayUrl), {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
          ...(init.headers || {}),
        },
      });
      const text = await response.text();
      let body = null;
      if (text) {
        try { body = JSON.parse(text); }
        catch { throw new Error(`relay returned invalid JSON (${response.status})`); }
      }
      if (!response.ok && response.status !== 204 && response.status !== 404) {
        throw new Error(body && body.error || `relay request failed (${response.status})`);
      }
      return { status: response.status, body };
    } finally {
      clearTimeout(timeout);
      requestControllers.delete(controller);
    }
  }

  async function registerRoom(code) {
    if (!relayUrl || role !== "host") return false;
    const response = await request("/v1/rooms", {
      method: "POST",
      body: JSON.stringify({ hostId, code }),
      timeoutMs: 5000,
    });
    if (response.status !== 200) throw new Error(`relay refused room ${code}`);
    logger(`[private-pvp] relay registered room=${code}`);
    return true;
  }

  async function requestJoin(code, user) {
    if (!relayUrl || role !== "join") return null;
    const response = await request(`/v1/rooms/${encodeURIComponent(code)}/join`, {
      method: "POST",
      body: JSON.stringify({ user }),
    });
    if (response.status !== 200 || !response.body) return { errorCode: 27301 };
    if (Number(response.body.errorCode || 0) !== 0) return response.body;
    const proxy = await createGuestProxy(response.body);
    return {
      errorCode: 0,
      serverIp: "127.0.0.1",
      port: proxy.port,
      accessToken: String(response.body.accessToken || ""),
    };
  }

  async function createGuestProxy(join) {
    const tunnelId = String(join.tunnelId || "");
    const token = String(join.guestTunnelToken || "");
    if (!tunnelId || !token) throw new Error("relay join response did not include a tunnel");
    return new Promise((resolve, reject) => {
      let settled = false;
      const server = net.createServer({ allowHalfOpen: false }, async (socket) => {
        server.close();
        localProxies.delete(server);
        try {
          await openBridge("guest", tunnelId, token, socket);
        } catch (error) {
          socket.destroy(error);
          logger(`[private-pvp] guest relay tunnel failed: ${error.message}`);
        }
      });
      localProxies.add(server);
      server.on("error", (error) => {
        localProxies.delete(server);
        if (!settled) reject(error);
      });
      server.listen(0, "127.0.0.1", () => {
        settled = true;
        const address = server.address();
        const port = address && typeof address === "object" ? address.port : 0;
        const timer = setTimeout(() => {
          localProxies.delete(server);
          server.close();
        }, PROXY_ACCEPT_TIMEOUT_MS);
        timer.unref();
        server.once("close", () => clearTimeout(timer));
        resolve({ port });
      });
    });
  }

  async function openBridge(tunnelRole, tunnelId, token, socket = null) {
    const target = new URL(`/v1/tunnels/${encodeURIComponent(tunnelId)}`, relayUrl);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    const websocket = await openWebSocket(target.href);
    websocket.binaryType = "arraybuffer";
    websocket.send(JSON.stringify({ secret, role: tunnelRole, token }));
    const localSocket = socket || net.createConnection({ host: "127.0.0.1", port: localGamePort });
    if (!socket) await waitForSocket(localSocket);
    const bridge = { websocket, socket: localSocket };
    bridges.add(bridge);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      bridges.delete(bridge);
      localSocket.destroy();
      try { websocket.close(); } catch { /* already closed */ }
    };
    localSocket.on("data", (chunk) => {
      if (websocket.readyState !== WebSocket.OPEN || websocket.bufferedAmount > MAX_BUFFERED_WEBSOCKET_BYTES) return close();
      websocket.send(chunk);
    });
    localSocket.on("error", close);
    localSocket.on("close", close);
    websocket.addEventListener("message", (event) => {
      const data = Buffer.from(event.data instanceof ArrayBuffer ? event.data : event.data.buffer || event.data);
      if (!localSocket.destroyed) localSocket.write(data);
    });
    websocket.addEventListener("error", close);
    websocket.addEventListener("close", close);
    logger(`[private-pvp] ${tunnelRole} relay tunnel=${tunnelId} connected`);
    return bridge;
  }

  async function runHostLoop() {
    let failureDelay = 500;
    while (!stopped) {
      try {
        await request(`/v1/hosts/${encodeURIComponent(hostId)}/heartbeat`, { method: "POST", body: "{}", timeoutMs: 5000 });
        const response = await request(`/v1/hosts/${encodeURIComponent(hostId)}/joins`, { method: "GET" });
        failureDelay = 500;
        if (response.status !== 200 || !response.body) continue;
        const pending = response.body;
        let result;
        try {
          result = await options.onJoin(pending.code, pending.user);
          if (result && Number(result.errorCode || 0) === 0) {
            await openBridge("host", String(pending.tunnelId || ""), String(pending.hostTunnelToken || ""));
          }
        } catch (error) {
          logger(`[private-pvp] relay join failed: ${error.message}`);
          result = { errorCode: 27301, accessToken: "" };
        }
        await request(`/v1/joins/${encodeURIComponent(pending.id)}/complete`, {
          method: "POST",
          body: JSON.stringify({
            errorCode: Number(result && result.errorCode != null ? result.errorCode : 27301),
            accessToken: String(result && result.accessToken || ""),
          }),
          timeoutMs: 5000,
        });
      } catch (error) {
        if (stopped) break;
        logger(`[private-pvp] relay host reconnecting: ${error.message}`);
        await delay(failureDelay);
        failureDelay = Math.min(10_000, failureDelay * 2);
      }
    }
  }

  function startHost() {
    if (!relayUrl || role !== "host" || hostLoopPromise) return hostLoopPromise;
    hostLoopPromise = runHostLoop();
    return hostLoopPromise;
  }

  function stop() {
    stopped = true;
    for (const controller of requestControllers) controller.abort();
    requestControllers.clear();
    for (const server of localProxies) server.close();
    localProxies.clear();
    for (const bridge of bridges) {
      bridge.socket.destroy();
      try { bridge.websocket.close(); } catch { /* already closed */ }
    }
    bridges.clear();
  }

  return {
    enabled: Boolean(relayUrl && role !== "off"),
    role,
    registerRoom,
    requestJoin,
    startHost,
    stop,
  };
}

function normalizeRelayUrl(value, allowInsecureLoopback = false) {
  const text = String(value || "").trim();
  if (!text) return "";
  const url = new URL(text);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(allowInsecureLoopback && loopback && url.protocol === "http:")) {
    throw new Error("The PvP relay URL must use HTTPS");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.href;
}

function openWebSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const fail = (event) => reject(event && event.error || new Error("relay WebSocket connection failed"));
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", fail, { once: true });
  });
}

function waitForSocket(socket) {
  return new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

module.exports = { createPrivatePvpRelayClient, normalizeRelayUrl };
