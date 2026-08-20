'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const net = require('net');
const path = require('path');
const { createPrivatePvpRelayClient } = require('../modules/private-pvp/relay-client');

const root = path.resolve(__dirname, '..');
const secret = 'test-secret-'.repeat(4);

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return response.json();
    } catch { /* relay is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('relay health endpoint did not become ready');
}

async function relayFetch(baseUrl, pathname, init = {}, authorize = true) {
  return fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(authorize ? { Authorization: `Bearer ${secret}` } : {}),
      ...(init.headers || {}),
    },
  });
}

function openTunnel(baseUrl, tunnelId, role, token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/v1/tunnels/${tunnelId}`);
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ secret, role, token }));
      resolve(socket);
    }, { once: true });
    socket.addEventListener('error', () => reject(new Error(`${role} WebSocket failed`)), { once: true });
  });
}

function nextBinary(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('relay tunnel message timed out')), 3000);
    socket.addEventListener('message', (event) => {
      clearTimeout(timeout);
      resolve(Buffer.from(event.data));
    }, { once: true });
  });
}

function connectTcp(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => resolve(socket));
    socket.once('error', reject);
  });
}

function nextTcpData(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('relay client TCP roundtrip timed out')), 5000);
    socket.once('data', (data) => { clearTimeout(timeout); resolve(data); });
    socket.once('error', (error) => { clearTimeout(timeout); reject(error); });
  });
}

async function main() {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = childProcess.spawn('dotnet', [
    'run', '--no-build', '--project', path.join(root, 'relay-host', 'RevivalSideRelay.csproj'),
  ], {
    cwd: root,
    env: {
      ...process.env,
      REVIVALSIDE_RELAY_SECRET: secret,
      REVIVALSIDE_RELAY_PORT: String(port),
      REVIVALSIDE_RELAY_INSECURE_LOOPBACK: '1',
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk.toString(); });
  try {
    const health = await waitForHealth(baseUrl);
    assert.strictEqual(health.service, 'revivalside-relay');
    assert.strictEqual(health.tls, false);
    const unauthorized = await relayFetch(baseUrl, '/v1/hosts/host-12345678/heartbeat', { method: 'POST', body: '{}' }, false);
    assert.strictEqual(unauthorized.status, 401);

    let response = await relayFetch(baseUrl, '/v1/hosts/host-12345678/heartbeat', { method: 'POST', body: '{}' });
    assert.strictEqual(response.status, 200);
    response = await relayFetch(baseUrl, '/v1/rooms', {
      method: 'POST',
      body: JSON.stringify({ hostId: 'host-12345678', code: 'A1B2C3D4' }),
    });
    assert.strictEqual(response.status, 200);

    const guestJoin = relayFetch(baseUrl, '/v1/rooms/A1B2C3D4/join', {
      method: 'POST',
      body: JSON.stringify({ user: { userUid: '1000000004', nickname: 'Guest' } }),
    });
    response = await relayFetch(baseUrl, '/v1/hosts/host-12345678/joins');
    assert.strictEqual(response.status, 200);
    const pending = await response.json();
    assert.strictEqual(pending.code, 'A1B2C3D4');
    assert.strictEqual(pending.user.nickname, 'Guest');
    const hostSocket = await openTunnel(baseUrl, pending.tunnelId, 'host', pending.hostTunnelToken);

    response = await relayFetch(baseUrl, `/v1/joins/${pending.id}/complete`, {
      method: 'POST',
      body: JSON.stringify({ errorCode: 0, accessToken: 'pvp-test-ticket' }),
    });
    assert.strictEqual(response.status, 200);
    response = await guestJoin;
    assert.strictEqual(response.status, 200);
    const joined = await response.json();
    assert.strictEqual(joined.accessToken, 'pvp-test-ticket');
    const guestSocket = await openTunnel(baseUrl, joined.tunnelId, 'guest', joined.guestTunnelToken);

    const atGuest = nextBinary(guestSocket);
    hostSocket.send(Buffer.from('host-to-guest'));
    assert.strictEqual((await atGuest).toString(), 'host-to-guest');
    const atHost = nextBinary(hostSocket);
    guestSocket.send(Buffer.from('guest-to-host'));
    assert.strictEqual((await atHost).toString(), 'guest-to-host');
    hostSocket.close();
    guestSocket.close();

    const echoServer = net.createServer((socket) => socket.pipe(socket));
    await new Promise((resolve, reject) => {
      echoServer.once('error', reject);
      echoServer.listen(0, '127.0.0.1', resolve);
    });
    const hostClient = createPrivatePvpRelayClient({
      relayUrl: baseUrl,
      allowInsecureLoopback: true,
      secret,
      hostId: 'host-client-1234',
      role: 'host',
      localGamePort: echoServer.address().port,
      logger() {},
      async onJoin() { return { errorCode: 0, accessToken: 'pvp-client-ticket' }; },
    });
    const guestClient = createPrivatePvpRelayClient({
      relayUrl: baseUrl,
      allowInsecureLoopback: true,
      secret,
      role: 'join',
      logger() {},
    });
    void hostClient.startHost();
    await hostClient.registerRoom('C1D2E3F4');
    const clientJoin = await guestClient.requestJoin('C1D2E3F4', { userUid: '1000000005', nickname: 'Client Guest' });
    assert.strictEqual(clientJoin.accessToken, 'pvp-client-ticket');
    assert(Number.isInteger(clientJoin.port) && clientJoin.port > 0, JSON.stringify(clientJoin));
    const gameSocket = await connectTcp(clientJoin.port);
    const roundtrip = nextTcpData(gameSocket);
    gameSocket.write(Buffer.from('relay-client-roundtrip'));
    assert.strictEqual((await roundtrip).toString(), 'relay-client-roundtrip');
    gameSocket.destroy();
    guestClient.stop();
    hostClient.stop();
    await new Promise((resolve) => echoServer.close(resolve));
    console.log('RevivalSide relay checks passed.');
  } finally {
    child.kill();
    await new Promise((resolve) => {
      child.once('exit', resolve);
      setTimeout(resolve, 2000).unref();
    });
    if (errors.trim()) process.stderr.write(errors);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
