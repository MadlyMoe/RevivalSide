"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { loadPacketHandlers } = require("../server/packetHandlerLoader");

const ROOT = path.resolve(__dirname, "..");
const ASSEMBLY_ROOT = path.join(ROOT, "Assembly-CSharp");
const SCHEMA_PATH = path.join(ROOT, "packet-schema.json");
const REVIEW_PATH = path.join(ROOT, "protocol", "coverage-review.json");
const MANIFEST_PATH = path.join(ROOT, "protocol", "manifest.json");
const HANDLER_ROOTS = [path.join(ROOT, "packet-handlers"), path.join(ROOT, "modules")];
const SERVER_SOURCE_ROOTS = [
  path.join(ROOT, "packet-handlers"),
  path.join(ROOT, "modules"),
  path.join(ROOT, "server"),
  path.join(ROOT, "combat-handler"),
];
const REGISTERED_CLIENT_RECEIVERS = new Set([
  "Assembly-CSharp/NKC/PacketHandler/NKCPacketHandlersLogin.cs",
  "Assembly-CSharp/NKC/PacketHandler/NKCPacketHandlersLobby.cs",
  "Assembly-CSharp/Cs/Engine/Network/Connection.cs",
]);
const STATUSES = new Set([
  "COMPLETE",
  "PARTIAL",
  "MISSING",
  "STUB",
  "INCORRECT",
  "EXTERNAL_COMPATIBILITY",
  "PROVEN_UNREACHABLE",
  "DEAD_LEGACY",
  "UNCLASSIFIED",
]);
const SPECIAL_REQUEST_RESPONSES = new Map([
  [200, 203],
  [201, 203],
  [202, 203],
  [221, 203],
  [229, 230],
  [231, 203],
  [800, 804],
  [802, 804],
  [3485, 804],
]);

function walk(root, extensions, output = []) {
  if (!fs.existsSync(root)) return output;
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    if (extensions.has(path.extname(root).toLowerCase())) output.push(root);
    return output;
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "bin" || entry.name === "obj" || entry.name === ".git") continue;
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) walk(target, extensions, output);
    else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) output.push(target);
  }
  return output;
}

function relative(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, "/");
}

function lineNumber(source, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (source.charCodeAt(index) === 10) line += 1;
  return line;
}

function location(filePath, source, offset, kind) {
  return { source: relative(filePath), line: lineNumber(source, offset), kind };
}

function uniqueLocations(locations) {
  const seen = new Set();
  return locations.filter((item) => {
    const key = `${item.source}:${item.line}:${item.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function withQuietHandlerLoad(callback) {
  const original = console.log;
  console.log = () => {};
  try {
    return callback();
  } finally {
    console.log = original;
  }
}

function sha256(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function packetStem(name) {
  return String(name || "").replace(/^NKMPAcket_/i, "NKMPacket_").replace(/_(REQ|ACK|NOT)$/i, "");
}

function normalizedPacketName(name) {
  return String(name || "").replace(/^NKM(?:Packet|PAcket)_/i, "").toUpperCase();
}

function featureFamily(packet) {
  const namespace = String(packet.namespace || "");
  const family = namespace.split(".").pop() || "Unknown";
  const name = normalizedPacketName(packet.name);
  if (/^(LOGIN|ZLONG_LOGIN|GAMEBASE_LOGIN|JOIN_LOBBY|RECONNECT|CONTENTS_VERSION)/.test(name)) return "Session";
  if (/^(GAME_|MATCH_GAME|RAID_GAME|PRACTICE_GAME|NPT_GAME)/.test(name)) return "Battle";
  return family === "Pvp" ? "PvP" : family === "LeaderBoard" ? "Leaderboard" : family;
}

function requiredSession(packet) {
  const name = normalizedPacketName(packet.name);
  if (/^(LOGIN|ZLONG_LOGIN|GAMEBASE_LOGIN)_/.test(name)) return "login-server connection";
  if (/^(JOIN_LOBBY|RECONNECT|CONTENTS_VERSION)_/.test(name)) return "authenticated or reconnecting session";
  if (featureFamily(packet) === "Battle") return "active lobby or battle session";
  return "authenticated lobby session";
}

function persistenceRequirement(packet) {
  if (packet.direction !== "client->server") return "not-applicable";
  const name = normalizedPacketName(packet.name);
  if (/(CHANGE|SET|UPDATE|COMPLETE|RECEIVE|BUY|PURCHASE|REMOVE|UNLOCK|ENHANCE|LEVEL|CLAIM|CLEAR|CREATE|DELETE|CANCEL|EQUIP|LOCK|FAVORITE|GIVE|SELECT|SAVE|RESET|RETRY|RESTORE|END)_REQ$/.test(name)) {
    return "required when the operation succeeds and changes durable user state";
  }
  return "no durable mutation proven from packet name alone";
}

function scanClientSources(packetsByName) {
  const references = new Map();
  const senderLocations = new Map();
  const receiverLocations = new Map();
  const consumedFields = new Map();
  const files = walk(ASSEMBLY_ROOT, new Set([".cs"]));
  const sources = [];

  for (const filePath of files) {
    const source = fs.readFileSync(filePath, "utf8");
    sources.push({ filePath, source });
    const rel = relative(filePath);
    const tokenPattern = /\bNKM(?:Packet|PAcket)[A-Za-z0-9_]*\b/g;
    for (const match of source.matchAll(tokenPattern)) {
      const packet = packetsByName.get(match[0]);
      if (!packet || rel === packet.source) continue;
      const list = references.get(packet.name) || [];
      list.push(location(filePath, source, match.index, "type-reference"));
      references.set(packet.name, list);
    }

    const senderPattern = /\bSend_(NKM(?:Packet|PAcket)[A-Za-z0-9_]*)\b/g;
    for (const match of source.matchAll(senderPattern)) {
      const packet = packetsByName.get(match[1]);
      if (!packet) continue;
      const lineStart = source.lastIndexOf("\n", match.index) + 1;
      const lineEnd = source.indexOf("\n", match.index);
      const line = source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd);
      const kind = /\b(?:public|private|internal)\s+static\s+void\s+Send_/.test(line) ? "sender-definition" : "sender-call";
      const list = senderLocations.get(packet.name) || [];
      list.push(location(filePath, source, match.index, kind));
      senderLocations.set(packet.name, list);
    }

    const receiverPattern = /\b(?:public|private|internal)?\s*(?:static\s+)?void\s+OnRecv\s*\(\s*(NKM(?:Packet|PAcket)[A-Za-z0-9_]*)\s+([A-Za-z0-9_]+)[^)]*\)\s*\{/g;
    for (const match of source.matchAll(receiverPattern)) {
      const packet = packetsByName.get(match[1]);
      if (!packet) continue;
      const registered = REGISTERED_CLIENT_RECEIVERS.has(rel);
      const list = receiverLocations.get(packet.name) || [];
      list.push(location(filePath, source, match.index, registered ? "registered-receiver" : "local-receiver"));
      receiverLocations.set(packet.name, list);
      if (!registered) continue;
      const body = extractBalancedBlock(source, source.indexOf("{", match.index));
      const fieldPattern = new RegExp(`\\b${match[2]}\\.([A-Za-z0-9_]+)`, "g");
      const fields = new Set(consumedFields.get(packet.name) || []);
      for (const fieldMatch of body.matchAll(fieldPattern)) fields.add(fieldMatch[1]);
      consumedFields.set(packet.name, Array.from(fields).sort());
    }
  }

  const aliases = [];
  for (const { filePath, source } of sources) {
    const methodPattern = /\b(?:public|private|internal)\s+static\s+void\s+(Send_[A-Za-z0-9_]+)\s*\([^)]*\)\s*\{/g;
    for (const match of source.matchAll(methodPattern)) {
      const body = extractBalancedBlock(source, source.indexOf("{", match.index));
      const packetNames = new Set(Array.from(body.matchAll(/\bnew\s+(NKM(?:Packet|PAcket)[A-Za-z0-9_]*)\s*\(/g), (entry) => entry[1]));
      for (const packetName of packetNames) {
        const packet = packetsByName.get(packetName);
        if (!packet || match[1] === `Send_${packetName}`) continue;
        aliases.push({ methodName: match[1], packet, filePath, definitionIndex: match.index + match[0].indexOf(match[1]) });
      }
    }
  }
  for (const alias of aliases) {
    const pattern = new RegExp(`\\b${alias.methodName}\\b`, "g");
    for (const { filePath, source } of sources) {
      for (const match of source.matchAll(pattern)) {
        const kind = filePath === alias.filePath && match.index === alias.definitionIndex ? "sender-definition" : "sender-call";
        const list = senderLocations.get(alias.packet.name) || [];
        list.push(location(filePath, source, match.index, kind));
        senderLocations.set(alias.packet.name, list);
      }
    }
  }

  return { references, senderLocations, receiverLocations, consumedFields };
}

function extractBalancedBlock(source, openBrace) {
  if (openBrace < 0) return "";
  let depth = 0;
  let string = null;
  let escaped = false;
  for (let index = openBrace; index < source.length; index += 1) {
    const char = source[index];
    if (string) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === string) string = null;
      continue;
    }
    if (char === '"' || char === "'") {
      string = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBrace, index + 1);
    }
  }
  return source.slice(openBrace);
}

function scanServerSources(packets) {
  const byToken = new Map();
  for (const packet of packets) byToken.set(normalizedPacketName(packet.name), packet);
  const references = new Map();
  for (const root of SERVER_SOURCE_ROOTS) {
    for (const filePath of walk(root, new Set([".js"]))) {
      const source = fs.readFileSync(filePath, "utf8");
      const pattern = /\b[A-Z][A-Z0-9_]*(?:REQ|ACK|NOT)\b/g;
      for (const match of source.matchAll(pattern)) {
        const packet = byToken.get(match[0]);
        if (!packet) continue;
        const list = references.get(packet.name) || [];
        list.push(location(filePath, source, match.index, "server-reference"));
        references.set(packet.name, list);
      }
    }
  }
  return references;
}

function scanTests(packets) {
  const refs = new Map();
  const tokens = new Map(packets.map((packet) => [normalizedPacketName(packet.name), packet]));
  for (const filePath of walk(path.join(ROOT, "tools"), new Set([".js", ".ps1", ".py"]))) {
    if (!/^check[-_]/i.test(path.basename(filePath))) continue;
    const source = fs.readFileSync(filePath, "utf8");
    const pattern = /\b[A-Z][A-Z0-9_]*(?:REQ|ACK|NOT)\b/g;
    for (const match of source.matchAll(pattern)) {
      const packet = tokens.get(match[0]);
      if (!packet) continue;
      const list = refs.get(packet.name) || [];
      list.push(location(filePath, source, match.index, "test-reference"));
      refs.set(packet.name, list);
    }
  }
  return refs;
}

function determineReachability(packet, client) {
  const references = uniqueLocations(client.references.get(packet.name) || []);
  const senders = uniqueLocations(client.senderLocations.get(packet.name) || []);
  const receivers = uniqueLocations(client.receiverLocations.get(packet.name) || []);
  const registeredReceivers = receivers.filter((item) => item.kind === "registered-receiver");
  const senderCalls = senders.filter((item) => item.kind === "sender-call");
  const senderDefinitions = senders.filter((item) => item.kind === "sender-definition");
  const inactivePublisher = /Assembly-CSharp\/NKC\/Publisher\/NKCPM(?:None|JPPC)\.cs$/;
  const nonLocalReferences = references.filter((item) => !/NKCLocal(PacketHandler|ServerManager)|NKCGameServerLocal/.test(item.source));
  const actionableReferences = nonLocalReferences.filter(
    (item) => !item.source.endsWith("/NKCPacketSender.cs") && !inactivePublisher.test(item.source)
  );
  const activeSenderCalls = senderCalls.filter((item) => !inactivePublisher.test(item.source));
  const referenced = references.length > 0 || senders.length > 0 || receivers.length > 0;
  let reachable = false;
  let actuallyRequired = false;
  if (packet.direction === "client->server") {
    reachable = actionableReferences.length > 0 || activeSenderCalls.length > 0;
    actuallyRequired = reachable;
  } else if (packet.direction === "server->client") {
    reachable = registeredReceivers.length > 0;
    actuallyRequired = reachable;
  }
  const evidence = [];
  if (senderCalls.length) evidence.push(`${senderCalls.length} client sender call site(s)`);
  if (senderDefinitions.length) evidence.push(`${senderDefinitions.length} client sender definition(s)`);
  if (registeredReceivers.length) evidence.push(`${registeredReceivers.length} registered client receiver(s)`);
  if (actionableReferences.length) evidence.push(`${actionableReferences.length} viable non-local client type reference(s)`);
  if (nonLocalReferences.length > actionableReferences.length) {
    evidence.push(`${nonLocalReferences.length - actionableReferences.length} sender-definition or inactive-publisher reference(s) excluded`);
  }
  if (!reachable) evidence.push("no viable frozen-client network send path or registered receive handler was found");
  return {
    stages: {
      defined: true,
      registered: registeredReceivers.length > 0,
      referenced,
      reachable,
      actuallyRequired,
    },
    evidence,
    references,
    senders,
    receivers,
  };
}

function relatedPackets(packet, packetsByStem) {
  return (packetsByStem.get(packetStem(packet.name).toUpperCase()) || [])
    .filter((candidate) => candidate.id !== packet.id)
    .map((candidate) => ({ id: candidate.id, name: candidate.name, direction: candidate.direction }));
}

function defaultStatus(packet, reachability, handler, relations, packetsById, serverReferences) {
  if (!reachability.stages.reachable) {
    return reachability.evidence.some((item) => /dead legacy|inactive-publisher/.test(item)) ? "DEAD_LEGACY" : "PROVEN_UNREACHABLE";
  }
  if (packet.direction === "client->server") {
    if (!handler) return "MISSING";
    if (handler.fileName.replace(/\\/g, "/").includes("modules/packet-hydration/handlers/")) return "STUB";
    return "PARTIAL";
  }
  if (packet.direction === "server->client") {
    const relatedRequest = relations.map((item) => packetsById.get(item.id)).find((item) => item && item.direction === "client->server");
    if (relatedRequest) {
      const relatedHandler = packetsById.handlers && packetsById.handlers.get(relatedRequest.id);
      if (relatedHandler && relatedHandler.fileName.replace(/\\/g, "/").includes("modules/packet-hydration/handlers/")) return "STUB";
      if (relatedHandler) return "PARTIAL";
    }
    return serverReferences.length ? "PARTIAL" : "MISSING";
  }
  return "UNCLASSIFIED";
}

function buildManifest() {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
  const review = fs.existsSync(REVIEW_PATH) ? JSON.parse(fs.readFileSync(REVIEW_PATH, "utf8")) : { packets: {} };
  const reviewGroups = Array.isArray(review.groups) ? review.groups : [];
  const packets = Object.values(schema.packets).sort((left, right) => left.id - right.id);
  const packetsByName = new Map(packets.map((packet) => [packet.name, packet]));
  const packetsById = new Map(packets.map((packet) => [packet.id, packet]));
  const packetsByStem = new Map();
  for (const packet of packets) {
    const stem = packetStem(packet.name).toUpperCase();
    const list = packetsByStem.get(stem) || [];
    list.push(packet);
    packetsByStem.set(stem, list);
  }
  const handlers = withQuietHandlerLoad(() => loadPacketHandlers(HANDLER_ROOTS, { rootDir: ROOT }));
  packetsById.handlers = handlers;
  const client = scanClientSources(packetsByName);
  const serverRefs = scanServerSources(packets);
  const testRefs = scanTests(packets);
  const reachabilityById = new Map(packets.map((packet) => [packet.id, determineReachability(packet, client)]));
  for (const packet of packets) {
    if (packet.direction !== "client->server") continue;
    const responseIds = new Set(
      relatedPackets(packet, packetsByStem)
        .map((item) => packetsById.get(item.id))
        .filter((item) => item && item.direction === "server->client" && item.name.endsWith("_ACK"))
        .map((item) => item.id)
    );
    if (SPECIAL_REQUEST_RESPONSES.has(packet.id)) responseIds.add(SPECIAL_REQUEST_RESPONSES.get(packet.id));
    if (!responseIds.size) continue;
    const hasRegisteredResponse = Array.from(responseIds).some((id) => reachabilityById.get(id).stages.registered);
    if (hasRegisteredResponse) continue;
    const reachability = reachabilityById.get(packet.id);
    reachability.stages.reachable = false;
    reachability.stages.actuallyRequired = false;
    reachability.evidence.push("request ACK has no reflection-registered receiver in the frozen client; the compiled sender path is dead legacy");
  }
  for (const packet of packets) {
    if (packet.direction !== "server->client" || !packet.name.endsWith("_ACK")) continue;
    const relatedRequests = relatedPackets(packet, packetsByStem)
      .map((item) => packetsById.get(item.id))
      .filter((item) => item && item.direction === "client->server");
    for (const [requestId, responseId] of SPECIAL_REQUEST_RESPONSES) {
      if (responseId === packet.id) relatedRequests.push(packetsById.get(requestId));
    }
    if (!relatedRequests.length || relatedRequests.some((request) => reachabilityById.get(request.id).stages.reachable)) continue;
    const reachability = reachabilityById.get(packet.id);
    reachability.stages.reachable = false;
    reachability.stages.actuallyRequired = false;
    reachability.evidence.push("registered ACK has no reachable request path in the frozen Steam build");
  }
  const manifestPackets = packets.map((packet) => {
    const handler = handlers.get(packet.id) || null;
    const reachability = reachabilityById.get(packet.id);
    const relations = relatedPackets(packet, packetsByStem);
    const serverReferences = uniqueLocations(serverRefs.get(packet.name) || []);
    const reviewEntry = (review.packets && review.packets[String(packet.id)]) ||
      reviewGroups.find((group) => Array.isArray(group.packetIds) && group.packetIds.includes(packet.id)) || null;
    if (reviewEntry && reviewEntry.reachability) {
      if (reviewEntry.reachability.reachable != null) reachability.stages.reachable = Boolean(reviewEntry.reachability.reachable);
      if (reviewEntry.reachability.actuallyRequired != null) {
        reachability.stages.actuallyRequired = Boolean(reviewEntry.reachability.actuallyRequired);
      }
      if (reviewEntry.reachability.note) reachability.evidence.push(reviewEntry.reachability.note);
    }
    const computedStatus = defaultStatus(packet, reachability, handler, relations, packetsById, serverReferences);
    const status = reviewEntry && reviewEntry.status ? reviewEntry.status : computedStatus;
    if (!STATUSES.has(status)) throw new Error(`invalid status ${status} for packet ${packet.id}`);
    const evidence = [
      { source: packet.source, note: "serialized packet contract" },
      ...reachability.senders,
      ...reachability.receivers,
      ...serverReferences,
      ...uniqueLocations(testRefs.get(packet.name) || []),
    ];
    if (handler) evidence.push({ source: handler.fileName.replace(/\\/g, "/"), note: "effective server request handler" });
    if (reviewEntry && Array.isArray(reviewEntry.evidence)) evidence.push(...reviewEntry.evidence);
    return {
      id: packet.id,
      name: packet.name,
      packetIdName: packet.packetIdName,
      direction: packet.direction,
      featureFamily: featureFamily(packet),
      clientPacketType: packet.direction === "client->server" ? packet.fullName : null,
      serverPacketType: packet.direction === "server->client" ? packet.fullName : null,
      serializer: `${packet.fullName}.ISerializable.Serialize`,
      deserializer: "Cs.Protocol.PacketReader",
      requestType: packet.direction === "client->server" ? packet.fullName : null,
      responseType: packet.direction === "server->client" ? packet.fullName : null,
      classification: packet.name.endsWith("_NOT") ? "notification/push" : packet.name.endsWith("_ACK") ? "response" : packet.name.endsWith("_REQ") ? "request" : "shared",
      source: packet.source,
      fields: packet.fields,
      fieldsConsumedByClient: client.consumedFields.get(packet.name) || [],
      clientSendLocations: reachability.senders,
      clientReceiveLocations: reachability.receivers,
      clientReferences: reachability.references,
      dispatcherRegistration: reachability.receivers.filter((item) => item.kind === "registered-receiver"),
      relatedPackets: relations,
      requiredSessionState: requiredSession(packet),
      serverStateExpectedToMutate: persistenceRequirement(packet),
      persistenceRequirement: persistenceRequirement(packet),
      possibleResultCodes: packet.fields.some((field) => field.name === "errorCode") ? ["NKM_ERROR_CODE values consumed by the client"] : [],
      errorBehavior: packet.fields.some((field) => field.name === "errorCode") ? "client receiver checks errorCode where registered; see receive evidence" : "no errorCode field in packet contract",
      followUpServerPushes: relations.filter((item) => item.name.endsWith("_NOT")),
      reachability,
      currentRevivalSideHandler: handler ? handler.fileName.replace(/\\/g, "/") : null,
      implementationKind: handler
        ? handler.fileName.replace(/\\/g, "/").includes("modules/packet-hydration/handlers/")
          ? "generic-hydrated-ack"
          : "dedicated-handler"
        : packet.direction === "server->client" && serverReferences.length
          ? "server-producer-reference"
          : "none",
      implementationStatus: status,
      computedStatus,
      testCoverage: uniqueLocations(testRefs.get(packet.name) || []),
      evidence,
      notes: reviewEntry && reviewEntry.notes ? reviewEntry.notes : reachability.evidence.join("; "),
      localCompatibilityBehavior: reviewEntry && reviewEntry.localCompatibilityBehavior ? reviewEntry.localCompatibilityBehavior : null,
    };
  });
  const summary = summarize(manifestPackets);
  return {
    schemaVersion: 1,
    sourceSchema: relative(SCHEMA_PATH),
    sourceSchemaGeneratedAt: schema.generatedAt,
    sourceSchemaWarnings: schema.warnings || [],
    clientBuild: {
      label: (review.clientBuild && review.clientBuild.label) || "frozen decompiled Assembly-CSharp build",
      packetIdSource: "Assembly-CSharp/Protocol/ClientPacketId.cs",
      packetIdSourceSha256: sha256(path.join(ASSEMBLY_ROOT, "Protocol", "ClientPacketId.cs")),
      assemblyArchive: fs.existsSync(path.join(ROOT, "Assembly-CSharp.zip")) ? "Assembly-CSharp.zip" : null,
      assemblyArchiveSha256: sha256(path.join(ROOT, "Assembly-CSharp.zip")),
    },
    methodology: {
      discovery: "PacketId attributes and ISerializable.Serialize field order from the frozen decompiled client",
      reachability: "Conservative static scan of client packet type references, sender calls, and reflection-registered OnRecv handlers",
      serverAudit: "Effective handler registry plus server producer/test references; COMPLETE requires an explicit evidence-backed review override",
    },
    allowedStatuses: Array.from(STATUSES),
    summary,
    packets: manifestPackets,
  };
}

function summarize(packets) {
  const reachable = packets.filter((packet) => packet.reachability.stages.reachable);
  const statusCounts = Object.fromEntries(Array.from(STATUSES, (status) => [status, 0]));
  for (const packet of reachable) statusCounts[packet.implementationStatus] += 1;
  const protocolComplete = reachable.filter((packet) => ["COMPLETE", "EXTERNAL_COMPATIBILITY"].includes(packet.implementationStatus));
  const semanticDenominator = reachable.filter((packet) => packet.implementationStatus !== "EXTERNAL_COMPATIBILITY");
  const semanticComplete = semanticDenominator.filter((packet) => packet.implementationStatus === "COMPLETE");
  const byFeature = {};
  for (const packet of reachable) {
    const family = byFeature[packet.featureFamily] || { reachable: 0, complete: 0, externalCompatibility: 0 };
    family.reachable += 1;
    if (packet.implementationStatus === "COMPLETE") family.complete += 1;
    if (packet.implementationStatus === "EXTERNAL_COMPATIBILITY") family.externalCompatibility += 1;
    byFeature[packet.featureFamily] = family;
  }
  for (const family of Object.values(byFeature)) {
    family.coveragePercent = family.reachable ? Number((((family.complete + family.externalCompatibility) / family.reachable) * 100).toFixed(2)) : 100;
  }
  return {
    totalDiscoveredPackets: packets.length,
    reachablePackets: reachable.length,
    deadOrUnreachablePackets: packets.length - reachable.length,
    statusCounts,
    protocolCoveragePercent: reachable.length ? Number(((protocolComplete.length / reachable.length) * 100).toFixed(2)) : 100,
    semanticCoveragePercent: semanticDenominator.length ? Number(((semanticComplete.length / semanticDenominator.length) * 100).toFixed(2)) : 100,
    byFeature,
  };
}

function validate(manifest, strict) {
  const errors = [];
  if (manifest.sourceSchemaWarnings.length) errors.push(`packet schema has ${manifest.sourceSchemaWarnings.length} warning(s)`);
  const ids = new Set();
  for (const packet of manifest.packets) {
    if (ids.has(packet.id)) errors.push(`duplicate packet id ${packet.id}`);
    ids.add(packet.id);
    if (!STATUSES.has(packet.implementationStatus)) errors.push(`packet ${packet.id} has invalid status ${packet.implementationStatus}`);
    if (["EXTERNAL_COMPATIBILITY", "PROVEN_UNREACHABLE", "DEAD_LEGACY"].includes(packet.implementationStatus) && !packet.notes) {
      errors.push(`packet ${packet.id} exception status lacks evidence/rationale`);
    }
    if (packet.direction === "client->server" && packet.reachability.stages.reachable && !packet.currentRevivalSideHandler) {
      errors.push(`reachable request ${packet.id} has no server handler`);
    }
  }
  if (strict) {
    const gaps = manifest.packets.filter(
      (packet) => packet.reachability.stages.reachable && ["PARTIAL", "MISSING", "STUB", "INCORRECT", "UNCLASSIFIED"].includes(packet.implementationStatus)
    );
    if (gaps.length) errors.push(`${gaps.length} reachable packet(s) are not complete or explicitly external-compatible`);
    if (manifest.summary.protocolCoveragePercent !== 100) errors.push(`protocol coverage is ${manifest.summary.protocolCoveragePercent}%`);
    if (manifest.summary.semanticCoveragePercent !== 100) errors.push(`semantic coverage is ${manifest.summary.semanticCoveragePercent}%`);
  }
  return errors;
}

function printSummary(manifest) {
  const summary = manifest.summary;
  console.log("RevivalSide Protocol Coverage");
  console.log(`Client build: ${manifest.clientBuild.label}`);
  console.log(`Total discovered packets: ${summary.totalDiscoveredPackets}`);
  console.log(`Reachable server-facing packets: ${summary.reachablePackets}`);
  for (const status of STATUSES) console.log(`${status.padEnd(24)} ${summary.statusCounts[status]}`);
  console.log(`Reachable Protocol Coverage: ${summary.protocolCoveragePercent.toFixed(2)}%`);
  console.log(`Semantic Coverage:           ${summary.semanticCoveragePercent.toFixed(2)}%`);
}

function main() {
  const args = new Set(process.argv.slice(2));
  const manifest = buildManifest();
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (args.has("--write")) {
    fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
    fs.writeFileSync(MANIFEST_PATH, serialized);
    console.log(`Wrote ${MANIFEST_PATH}`);
  }
  if (args.has("--check")) {
    if (!fs.existsSync(MANIFEST_PATH)) throw new Error(`missing ${MANIFEST_PATH}; run with --write`);
    const existing = fs.readFileSync(MANIFEST_PATH, "utf8");
    if (existing !== serialized) throw new Error("protocol manifest is stale; run npm run protocol:audit");
  }
  printSummary(manifest);
  const errors = validate(manifest, args.has("--strict"));
  if (errors.length) {
    for (const error of errors) console.error(`[protocol-audit] ${error}`);
    process.exitCode = 1;
  } else {
    console.log(`[protocol-audit] PASS strict=${args.has("--strict") ? 1 : 0}`);
  }
}

main();
