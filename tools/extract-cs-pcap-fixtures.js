const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const HEAD_FENCE = 0xaabbccdd;
const TAIL_FENCE = 0x11223344;
const TSHARK_PATH = process.env.CS_TSHARK_PATH || "C:\\Program Files\\Wireshark\\tshark.exe";
const KNOWN_GAME_SERVER_PORTS = new Set(["20001", "20002", "20003", "20004", "22000"]);

if (process.argv[2] === "--self-test") {
  selfTest();
  process.exit(0);
}

function usage() {
  console.error(
    "usage: node tools/extract-cs-pcap-fixtures.js <pcap> <outDir> <tcp|game> <stream> [clientHost]\n" +
      "  tcp:  writes captured-tcp manifest entries for server packets\n" +
      "  game: writes captured-game-flow manifest for client/server packets"
  );
  process.exit(2);
}

const [pcap, outDir, mode, streamArg, clientHostArg] = process.argv.slice(2);
if (!pcap || !outDir || !mode || !streamArg) usage();
const stream = Number(streamArg);
if (!Number.isFinite(stream)) usage();

const clientHost = clientHostArg || "";
const followed = readFollowedStream(pcap, stream);
let endpoints = inferEndpoints(followed, clientHost);
let flow = buildPacketFlow(followed, endpoints);
if (mode === "game") {
  const reversed = buildPacketFlow(followed, { client: endpoints.server, server: endpoints.client });
  if (shouldPreferFlow(reversed, flow)) {
    endpoints = { client: endpoints.server, server: endpoints.client };
    flow = reversed;
  }
}

fs.mkdirSync(outDir, { recursive: true });

if (mode === "tcp") {
  writeTcpFixtures(outDir, pcap, stream, flow.serverPackets);
} else if (mode === "game") {
  writeGameFixtures(outDir, pcap, stream, flow.clientPackets, flow.serverPackets);
} else {
  usage();
}

console.log(
  `[extract] mode=${mode} stream=${stream} client=${endpoints.client} server=${endpoints.server} clientPackets=${flow.clientPackets.length} serverPackets=${flow.serverPackets.length} out=${outDir}`
);

function readFollowedStream(file, tcpStream) {
  const result = spawnSync(
    TSHARK_PATH,
    ["-n", "-q", "-r", file, "-z", `follow,tcp,raw,${tcpStream}`],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }
  );
  if (result.error) throw result.error;
  if (!String(result.stdout || "").trim()) {
    throw new Error(String(result.stderr || `tshark could not read stream ${tcpStream}`).trim());
  }
  return parseFollowOutput(result.stdout, tcpStream);
}

function parseFollowOutput(output, tcpStream) {
  const nodes = [{ endpoint: "", chunks: [] }, { endpoint: "", chunks: [] }];
  for (const line of String(output || "").replace(/\r/g, "").split("\n")) {
    const node = line.match(/^Node ([01]):\s+(.+)$/);
    if (node) {
      nodes[Number(node[1])].endpoint = node[2].trim();
      continue;
    }
    const payload = line.match(/^(\t?)([0-9a-f]+)\s*$/i);
    if (!payload || payload[2].length % 2 !== 0) continue;
    nodes[payload[1] ? 1 : 0].chunks.push(Buffer.from(payload[2], "hex"));
  }
  if (nodes.some((node) => !node.endpoint) || nodes.every((node) => node.chunks.length === 0)) {
    throw new Error(`no followed tcp payload for stream ${tcpStream}`);
  }
  return nodes.map((node) => ({ endpoint: node.endpoint, payload: Buffer.concat(node.chunks) }));
}

function selfTest() {
  const ack = "ddccbbaa1400000002cd01000601020344332211";
  const followed = parseFollowOutput([
    "Follow: tcp,raw",
    "Node 0: 192.168.1.2:50000",
    "Node 1: 203.0.113.10:20003",
    `\t${ack.slice(0, 18)}`,
    `\t${ack.slice(18)}`,
  ].join("\n"), 1);
  const endpoints = inferEndpoints(followed, "");
  const flow = buildPacketFlow(followed, endpoints);
  const packet = flow.serverPackets[0];
  if (flow.serverPackets.length !== 1 || packet.packetId !== 205 || !packet.payload.equals(Buffer.from([1, 2, 3]))) {
    throw new Error("followed TCP stream did not reconstruct JOIN_LOBBY_ACK");
  }
  console.log("cross-save extractor self-test passed");
}

function inferEndpoints(followed, preferredClientHost) {
  const endpoints = followed.map((node) => node.endpoint);
  if (endpoints.length !== 2) throw new Error(`expected 2 endpoints, got ${endpoints.length}`);

  const preferred = endpoints.find((endpoint) => preferredClientHost && endpoint.startsWith(`${preferredClientHost}:`));
  if (preferred) {
    return { client: preferred, server: endpoints.find((endpoint) => endpoint !== preferred) };
  }

  const knownServer = endpoints.find((endpoint) => KNOWN_GAME_SERVER_PORTS.has(endpointPort(endpoint)));
  if (knownServer) return { client: endpoints.find((endpoint) => endpoint !== knownServer), server: knownServer };

  const localEndpoints = endpoints.filter((endpoint) => isLocalHost(endpointHost(endpoint)));
  if (localEndpoints.length === 1) return { client: localEndpoints[0], server: endpoints.find((endpoint) => endpoint !== localEndpoints[0]) };

  const sortedByPort = endpoints.slice().sort((left, right) => endpointPortNumber(right) - endpointPortNumber(left));
  return { client: sortedByPort[0], server: sortedByPort[1] };
}

function buildPacketFlow(followed, endpoints) {
  const payload = (endpoint) => followed.find((node) => node.endpoint === endpoint)?.payload || Buffer.alloc(0);
  return {
    clientPackets: parsePackets(payload(endpoints.client)),
    serverPackets: parsePackets(payload(endpoints.server)),
  };
}

function shouldPreferFlow(candidate, current) {
  const candidateJoinLobby = countPackets(candidate.serverPackets, 205);
  const currentJoinLobby = countPackets(current.serverPackets, 205);
  if (candidateJoinLobby !== currentJoinLobby) return candidateJoinLobby > currentJoinLobby;
  return scoreServerPackets(candidate.serverPackets) > scoreServerPackets(current.serverPackets);
}

function countPackets(packets, packetId) {
  return packets.filter((packet) => packet.packetId === packetId).length;
}

function scoreServerPackets(packets) {
  return packets.reduce((score, packet) => {
    if (packet.packetId === 205) return score + 1000;
    if (packet.packetId > 0 && packet.packetId % 2 === 1) return score + 1;
    return score;
  }, 0);
}

function endpointPort(endpoint) {
  const text = String(endpoint || "");
  const index = text.lastIndexOf(":");
  return index >= 0 ? text.slice(index + 1) : "";
}

function endpointPortNumber(endpoint) {
  const port = Number(endpointPort(endpoint));
  return Number.isInteger(port) ? port : 0;
}

function endpointHost(endpoint) {
  const text = String(endpoint || "");
  const index = text.lastIndexOf(":");
  return index >= 0 ? text.slice(0, index) : text;
}

function isLocalHost(host) {
  const text = String(host || "").toLowerCase();
  if (!text) return false;
  if (text === "::1" || text === "localhost") return true;
  if (text.startsWith("127.")) return true;
  if (text.startsWith("10.")) return true;
  if (text.startsWith("192.168.")) return true;
  const ipv4 = text.match(/^172\.(\d+)\./);
  if (ipv4 && Number(ipv4[1]) >= 16 && Number(ipv4[1]) <= 31) return true;
  return text.startsWith("fc") || text.startsWith("fd") || text.startsWith("fe80:");
}

function parsePackets(buffer) {
  const packets = [];
  let offset = 0;
  while (offset + 12 <= buffer.length) {
    const fence = buffer.indexOf(Buffer.from([0xdd, 0xcc, 0xbb, 0xaa]), offset);
    if (fence < 0) break;
    if (fence + 12 > buffer.length) break;
    const totalLength = buffer.readInt32LE(fence + 4);
    if (totalLength <= 12 || fence + totalLength > buffer.length) {
      offset = fence + 1;
      continue;
    }
    const raw = buffer.subarray(fence, fence + totalLength);
    const tail = raw.readUInt32LE(totalLength - 4);
    if (tail !== TAIL_FENCE) {
      offset = fence + 1;
      continue;
    }
    packets.push(parsePacket(raw));
    offset = fence + totalLength;
  }
  return packets;
}

function parsePacket(raw) {
  if (raw.readUInt32LE(0) !== HEAD_FENCE) throw new Error("invalid head fence");
  const totalLength = raw.readInt32LE(4);
  let offset = 8;
  const sequenceRaw = readVarLong(raw, offset);
  offset = sequenceRaw.offset;
  const packetIdRaw = readVarInt(raw, offset);
  offset = packetIdRaw.offset;
  const compressed = raw.readUInt8(offset) !== 0;
  offset += 1;
  const payloadSizeRaw = readSignedVarInt(raw, offset);
  offset = payloadSizeRaw.offset;
  const payloadStart = offset;
  const payloadEnd = payloadStart + payloadSizeRaw.value;
  return {
    raw,
    totalLength,
    sequence: zigZagDecode64(sequenceRaw.value).toString(),
    packetId: packetIdRaw.value,
    compressed,
    payloadSize: payloadSizeRaw.value,
    payload: raw.subarray(payloadStart, payloadEnd),
    tail: raw.readUInt32LE(totalLength - 4),
    frame: 0,
    time: 0,
  };
}

function writeTcpFixtures(dir, sourcePcap, tcpStream, packets) {
  const manifest = {};
  for (const packet of packets) {
    const key = String(packet.packetId);
    if (packet.packetId !== 203 && packet.packetId !== 217) continue;
    const rawFile = `${key}.packet.bin`;
    const payloadFile = `${key}.payload.bin`;
    fs.writeFileSync(path.join(dir, rawFile), packet.raw);
    fs.writeFileSync(path.join(dir, payloadFile), packet.payload);
    manifest[key] = packetManifest(packet, sourcePcap, tcpStream, rawFile, payloadFile);
  }
  const existingPath = path.join(dir, "manifest.json");
  const existing = fs.existsSync(existingPath) ? JSON.parse(fs.readFileSync(existingPath, "utf8")) : {};
  fs.writeFileSync(existingPath, JSON.stringify({ ...existing, ...manifest }, null, 2));
}

function writeGameFixtures(dir, sourcePcap, tcpStream, clients, servers) {
  cleanOldFlow(dir);
  const manifest = { sourcePcap, stream: tcpStream, client: [], server: [] };
  for (let index = 0; index < clients.length; index += 1) {
    manifest.client.push(writeFlowPacket(dir, "client", index + 1, clients[index], sourcePcap, tcpStream));
  }
  for (let index = 0; index < servers.length; index += 1) {
    manifest.server.push(writeFlowPacket(dir, "server", index + 1, servers[index], sourcePcap, tcpStream));
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

function cleanOldFlow(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const file of fs.readdirSync(dir)) {
    if (/^(client|server)_\d+_\d+\.(packet|payload)\.bin$/.test(file) || file === "manifest.json") {
      fs.unlinkSync(path.join(dir, file));
    }
  }
}

function writeFlowPacket(dir, side, index, packet, sourcePcap, tcpStream) {
  const prefix = `${side}_${String(index).padStart(3, "0")}_${packet.packetId}`;
  const rawFile = `${prefix}.packet.bin`;
  const payloadFile = `${prefix}.payload.bin`;
  fs.writeFileSync(path.join(dir, rawFile), packet.raw);
  fs.writeFileSync(path.join(dir, payloadFile), packet.payload);
  return {
    seq: Number(packet.sequence),
    packetId: packet.packetId,
    compressed: packet.compressed,
    payloadSize: packet.payloadSize,
    totalLength: packet.totalLength,
    rawFile,
    payloadFile,
    sourcePcap,
    stream: tcpStream,
    frame: packet.frame,
    time: packet.time,
    sha256: sha256(packet.raw),
  };
}

function packetManifest(packet, sourcePcap, tcpStream, rawFile, payloadFile) {
  return {
    packetId: packet.packetId,
    stream: tcpStream,
    sequence: Number(packet.sequence),
    compressed: packet.compressed,
    payloadSize: packet.payloadSize,
    payloadFile,
    rawFile,
    totalLength: packet.totalLength,
    tail: packet.tail,
    sourcePcap,
    frame: packet.frame,
    time: packet.time,
    sha256: sha256(packet.raw),
  };
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function readVarInt(buffer, offset) {
  let result = 0;
  let shift = 0;
  let current = offset;
  while (current < buffer.length) {
    const byte = buffer[current++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result >>> 0, offset: current };
    shift += 7;
  }
  throw new Error("unterminated varint");
}

function readVarLong(buffer, offset) {
  let result = 0n;
  let shift = 0n;
  let current = offset;
  while (current < buffer.length) {
    const byte = BigInt(buffer[current++]);
    result |= (byte & 0x7fn) << shift;
    if ((byte & 0x80n) === 0n) return { value: result, offset: current };
    shift += 7n;
  }
  throw new Error("unterminated varlong");
}

function readSignedVarInt(buffer, offset) {
  const raw = readVarInt(buffer, offset);
  return { value: zigZagDecode32(raw.value), offset: raw.offset };
}

function zigZagDecode32(value) {
  return (value >>> 1) ^ -(value & 1);
}

function zigZagDecode64(value) {
  return (value >> 1n) ^ -(value & 1n);
}
