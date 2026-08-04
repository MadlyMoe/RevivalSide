const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SCHEMA_VERSION = 1;
const MAX_ARCHIVE_ENTRIES = 10000;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

function createModProjectStore(options = {}) {
  const modsRoot = path.resolve(options.modsRoot || path.join(options.rootDir || path.join(__dirname, "..", ".."), "mods"));

  function listProjects() {
    if (!fs.existsSync(modsRoot)) return [];
    return fs.readdirSync(modsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => {
        try { return projectSummary(readProject(entry.name)); }
        catch (_) { return null; }
      })
      .filter(Boolean)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  function createProject(input = {}) {
    const id = validateModId(input.id);
    const target = projectPath(id);
    if (fs.existsSync(target)) throw httpError(409, `Mod project ${id} already exists.`);
    fs.mkdirSync(path.join(target, "patches"), { recursive: true });
    fs.mkdirSync(path.join(target, "tables"), { recursive: true });
    fs.mkdirSync(path.join(target, "assets"), { recursive: true });
    writeJsonAtomic(path.join(target, "mod.json"), normalizeManifest({ ...input, id }));
    writeJsonAtomic(path.join(target, "mod.lock.json"), { schemaVersion: SCHEMA_VERSION, allocations: {} });
    return readProject(id);
  }

  function readProject(id) {
    const root = requireProject(id);
    const manifest = readJson(path.join(root, "mod.json"), "mod.json");
    const lock = readOptionalJson(path.join(root, "mod.lock.json"), { schemaVersion: SCHEMA_VERSION, allocations: {} });
    return {
      root,
      manifest,
      lock,
      patches: listPatchFiles(root).map((file) => readPatchFile(root, file)),
      tables: listFullTableFiles(root).map((file) => readFullTableFile(root, file)),
      strings: readOptionalJson(path.join(root, "strings.json"), {}),
      assetReplacements: readAssetReplacements(root),
    };
  }

  function updateManifest(id, input = {}) {
    const project = readProject(id);
    const manifest = normalizeManifest({ ...project.manifest, ...input, id: project.manifest.id });
    writeJsonAtomic(path.join(project.root, "mod.json"), manifest);
    return readProject(id);
  }

  function deleteProject(id) {
    const project = readProject(id);
    if (!isInside(modsRoot, project.root)) throw httpError(400, "Invalid mod project path.");
    fs.rmSync(project.root, { recursive: true });
    return projectSummary(project);
  }

  function copyProject(id, input = {}) {
    const source = readProject(id);
    const targetId = validateModId(input.id);
    const target = projectPath(targetId);
    if (fs.existsSync(target)) throw httpError(409, `Mod project ${targetId} already exists.`);
    fs.mkdirSync(modsRoot, { recursive: true });
    const temporary = path.join(modsRoot, `.copy-${targetId}-${crypto.randomBytes(6).toString("hex")}`);
    try {
      fs.mkdirSync(temporary, { recursive: true });
      for (const filePath of listProjectFiles(source.root)) {
        const destination = path.join(temporary, path.relative(source.root, filePath));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(filePath, destination);
      }
      writeJsonAtomic(path.join(temporary, "mod.json"), normalizeManifest({ ...source.manifest, ...input, id: targetId }));
      fs.renameSync(temporary, target);
    } catch (err) {
      if (isInside(modsRoot, temporary) && fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true });
      throw err;
    }
    return readProject(targetId);
  }

  function writePatch(id, patch, previousPatchId = "") {
    validatePatch(patch);
    const root = requireProject(id);
    const directory = safePart(patch.table.directory || "root");
    const table = safePart(patch.table.tableName || path.basename(patch.table.fileName, path.extname(patch.table.fileName)));
    const identity = crypto.createHash("sha256").update(`${patch.key.field}\0${JSON.stringify(patch.key.value)}`).digest("hex").slice(0, 16);
    const filePath = path.join(root, "patches", directory, table, `${identity}.json`);
    writeJsonAtomic(filePath, { schemaVersion: SCHEMA_VERSION, ...patch });
    const patchId = relativeFile(root, filePath);
    if (previousPatchId && previousPatchId !== patchId) removePatch(id, previousPatchId, { optional: true });
    return readPatchFile(root, filePath);
  }

  function removePatch(id, patchId, options = {}) {
    const root = requireProject(id);
    const filePath = resolvePatchPath(root, patchId);
    if (!fs.existsSync(filePath)) {
      if (options.optional) return false;
      throw httpError(404, "Mod patch was not found.");
    }
    fs.unlinkSync(filePath);
    removeEmptyParents(path.dirname(filePath), path.join(root, "patches"));
    return true;
  }

  function writeFullTable(id, input) {
    validateFullTable(input);
    const root = requireProject(id);
    const filePath = path.join(root, "tables", safePart(input.table.directory), `${safePart(input.table.tableName)}.json`);
    writeJsonAtomic(filePath, { schemaVersion: SCHEMA_VERSION, ...input });
    return readFullTableFile(root, filePath);
  }

  function writeString(id, key, value) {
    if (!/^[A-Za-z0-9_.-]{1,180}$/.test(String(key || ""))) throw httpError(400, "String key contains unsupported characters.");
    const project = readProject(id);
    const strings = { ...project.strings, [key]: String(value || "") };
    writeJsonAtomic(path.join(project.root, "strings.json"), strings);
    return strings;
  }

  function removeString(id, key) {
    const project = readProject(id);
    if (!Object.prototype.hasOwnProperty.call(project.strings, key)) return project.strings;
    const strings = { ...project.strings };
    delete strings[key];
    writeJsonAtomic(path.join(project.root, "strings.json"), strings);
    return strings;
  }

  function writeAssetSource(id, relativePath, body) {
    const root = requireProject(id);
    const normalized = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!normalized || normalized.includes("..") || normalized.split("/").some((part) => !part || part === ".")) throw httpError(400, "Invalid asset source path.");
    const filePath = path.resolve(root, "assets", "source", normalized);
    if (!isInside(path.join(root, "assets", "source"), filePath)) throw httpError(400, "Invalid asset source path.");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, body);
    return relativeFile(root, filePath);
  }

  function writeAssetReplacement(id, input, body) {
    const root = requireProject(id);
    const replacement = normalizeAssetReplacement(input);
    replacement.source = writeAssetSource(id, `replacements/${safePart(replacement.bundleName)}/${safePart(path.basename(path.dirname(replacement.targetPath)))}/${path.basename(replacement.targetPath)}`, body);
    const replacements = readAssetReplacements(root).filter((entry) => entry.targetPath.toLowerCase() !== replacement.targetPath.toLowerCase());
    replacements.push(replacement);
    writeJsonAtomic(path.join(root, "assets", "replacements.json"), replacements.sort((left, right) => left.targetPath.localeCompare(right.targetPath)));
    return replacement;
  }

  function allocateId(id, namespace, usedValues = []) {
    const project = readProject(id);
    const used = new Set(usedValues.map(Number).filter(Number.isSafeInteger));
    const allocations = project.lock.allocations && typeof project.lock.allocations === "object" ? project.lock.allocations : {};
    let next = Math.max(1, Number(allocations[namespace] || 1), ...Array.from(used, (value) => value + 1));
    while (used.has(next)) next += 1;
    allocations[namespace] = next + 1;
    writeJsonAtomic(path.join(project.root, "mod.lock.json"), { schemaVersion: SCHEMA_VERSION, allocations });
    return next;
  }

  function exportProject(id) {
    const project = readProject(id);
    return createZip(listProjectFiles(project.root).map((filePath) => ({
      name: relativeFile(project.root, filePath),
      data: fs.readFileSync(filePath),
    })));
  }

  function importProject(buffer) {
    let archive;
    try { archive = readZip(buffer); }
    catch (err) { throw err.statusCode ? err : httpError(400, `Invalid ZIP archive: ${err.message}`); }
    const entries = stripArchiveRoot(archive);
    const manifestEntry = entries.find((entry) => entry.name === "mod.json");
    if (!manifestEntry) throw httpError(400, "Archive does not contain mod.json.");
    let manifest;
    try { manifest = normalizeManifest(JSON.parse(manifestEntry.data.toString("utf8"))); }
    catch (err) { throw httpError(400, `Invalid mod.json: ${err.message}`); }
    const target = projectPath(manifest.id);
    if (fs.existsSync(target)) throw httpError(409, `Mod project ${manifest.id} already exists.`);
    fs.mkdirSync(modsRoot, { recursive: true });
    const temporary = path.join(modsRoot, `.import-${manifest.id}-${crypto.randomBytes(6).toString("hex")}`);
    try {
      fs.mkdirSync(temporary, { recursive: true });
      for (const entry of entries) {
        const filePath = resolveArchiveFile(temporary, entry.name);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, entry.data);
      }
      if (!fs.existsSync(path.join(temporary, "mod.lock.json"))) {
        writeJsonAtomic(path.join(temporary, "mod.lock.json"), { schemaVersion: SCHEMA_VERSION, allocations: {} });
      }
      fs.mkdirSync(path.join(temporary, "patches"), { recursive: true });
      fs.mkdirSync(path.join(temporary, "tables"), { recursive: true });
      fs.mkdirSync(path.join(temporary, "assets"), { recursive: true });
      for (const filePath of listPatchFiles(temporary)) validatePatch(readJson(filePath, relativeFile(temporary, filePath)));
      for (const filePath of listFullTableFiles(temporary)) validateFullTable(readJson(filePath, relativeFile(temporary, filePath)));
      readAssetReplacements(temporary);
      fs.renameSync(temporary, target);
    } catch (err) {
      if (isInside(modsRoot, temporary) && fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true });
      throw err;
    }
    return readProject(manifest.id);
  }

  function projectPath(id) {
    const safeId = validateModId(id);
    return path.join(modsRoot, safeId);
  }

  function requireProject(id) {
    const target = projectPath(id);
    if (!fs.existsSync(path.join(target, "mod.json"))) throw httpError(404, `Mod project ${id} was not found.`);
    return target;
  }

  return { modsRoot, listProjects, createProject, readProject, updateManifest, deleteProject, copyProject, writePatch, removePatch, writeFullTable, writeString, removeString, writeAssetSource, writeAssetReplacement, allocateId, exportProject, importProject };
}

function readAssetReplacements(root) {
  const value = readOptionalJson(path.join(root, "assets", "replacements.json"), []);
  if (!Array.isArray(value)) throw httpError(422, "assets/replacements.json must be an array.");
  return value.map(normalizeAssetReplacement);
}

function normalizeAssetReplacement(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw httpError(400, "Asset replacement must be an object.");
  const targetPath = String(input.targetPath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const source = String(input.source || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const bundleName = String(input.bundleName || "").trim().toLowerCase();
  if (!targetPath || targetPath.includes("..")) throw httpError(400, "Asset replacement target path is invalid.");
  if (!/^[a-z0-9][a-z0-9._-]{1,127}$/.test(bundleName)) throw httpError(400, "Asset replacement bundle name is invalid.");
  if (source && (!source.startsWith("assets/source/") || source.includes(".."))) throw httpError(400, "Asset replacement source path is invalid.");
  return {
    targetPath,
    bundleName,
    assetName: String(input.assetName || path.basename(targetPath, path.extname(targetPath))).slice(0, 240),
    extension: String(input.extension || path.extname(targetPath)).toLowerCase(),
    unityType: input.unityType === "Sprite" ? "Sprite" : "Default",
    source,
    originalBytes: Math.max(0, Number(input.originalBytes) || 0),
    width: Math.max(0, Number(input.width) || 0),
    height: Math.max(0, Number(input.height) || 0),
  };
}

function normalizeManifest(input = {}) {
  const id = validateModId(input.id);
  const name = String(input.name || id).trim();
  if (!name) throw httpError(400, "Mod name is required.");
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    name: name.slice(0, 120),
    version: String(input.version || "0.1.0").trim().slice(0, 40),
    author: String(input.author || "").trim().slice(0, 120),
    description: String(input.description || "").trim().slice(0, 2000),
  };
}

function validateModId(value) {
  const id = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id)) throw httpError(400, "Mod ID must be 2-64 lowercase letters, numbers, dots, dashes, or underscores.");
  return id;
}

function validatePatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw httpError(400, "Patch must be an object.");
  if (!patch.table || typeof patch.table !== "object") throw httpError(400, "Patch table is required.");
  for (const field of ["directory", "fileName", "tableName"]) {
    if (!String(patch.table[field] || "").trim()) throw httpError(400, `Patch table.${field} is required.`);
  }
  if (!patch.key || typeof patch.key !== "object" || !String(patch.key.field || "").trim()) throw httpError(400, "Patch key field is required.");
  if (patch.key.value == null || !["string", "number"].includes(typeof patch.key.value)) throw httpError(400, "Patch key value must be a string or number.");
  if (patch.value !== null && (!patch.value || typeof patch.value !== "object" || Array.isArray(patch.value))) throw httpError(400, "Patch value must be an object or null.");
  return patch;
}

function validateFullTable(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw httpError(400, "Full table must be an object.");
  if (!input.table || typeof input.table !== "object") throw httpError(400, "Full table metadata is required.");
  for (const field of ["directory", "fileName", "tableName"]) {
    if (!String(input.table[field] || "").trim()) throw httpError(400, `Full table table.${field} is required.`);
  }
  if (!input.compiled || typeof input.compiled !== "object" || Array.isArray(input.compiled)) throw httpError(400, "Full table compiled data is required.");
  return input;
}

function projectSummary(project) {
  return { ...project.manifest, patchCount: project.patches.length, tableCount: project.tables.length, stringCount: Object.keys(project.strings).length, assetReplacementCount: project.assetReplacements.length, episodeProject: fs.existsSync(path.join(project.root, "assets", "source", "episode-maker", "project.json")) };
}

function listPatchFiles(root) {
  const patchRoot = path.join(root, "patches");
  if (!fs.existsSync(patchRoot)) return [];
  return listFiles(patchRoot).filter((filePath) => path.extname(filePath).toLowerCase() === ".json");
}

function readPatchFile(root, filePath) {
  const patch = readJson(filePath, relativeFile(root, filePath));
  validatePatch(patch);
  return { ...patch, patchId: relativeFile(root, filePath) };
}

function listFullTableFiles(root) {
  const tableRoot = path.join(root, "tables");
  if (!fs.existsSync(tableRoot)) return [];
  return listFiles(tableRoot).filter((filePath) => path.extname(filePath).toLowerCase() === ".json");
}

function readFullTableFile(root, filePath) {
  const table = readJson(filePath, relativeFile(root, filePath));
  validateFullTable(table);
  return { ...table, tableId: relativeFile(root, filePath) };
}

function listProjectFiles(root) {
  return listFiles(root).filter((filePath) => !path.basename(filePath).includes(".tmp-"));
}

function listFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(filePath);
      else if (entry.isFile()) files.push(filePath);
    }
  }
  return files.sort();
}

function resolvePatchPath(root, patchId) {
  const normalized = String(patchId || "").replace(/\\/g, "/");
  if (!normalized.startsWith("patches/") || normalized.includes("..")) throw httpError(400, "Invalid patch path.");
  const target = path.resolve(root, normalized);
  if (!isInside(root, target)) throw httpError(403, "Patch path leaves the mod project.");
  return target;
}

function removeEmptyParents(start, stop) {
  let current = start;
  while (isInside(stop, current) && current !== stop && fs.existsSync(current) && fs.readdirSync(current).length === 0) {
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${crypto.randomBytes(6).toString("hex")}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}

function readJson(filePath, label) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch (err) { throw httpError(422, `${label} is invalid JSON: ${err.message}`); }
}

function readOptionalJson(filePath, fallback) {
  return fs.existsSync(filePath) ? readJson(filePath, path.basename(filePath)) : fallback;
}

function safePart(value) {
  return String(value || "data").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "data";
}

function relativeFile(root, filePath) {
  return path.relative(root, filePath).replace(/\\/g, "/");
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function createZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const now = dosDateTime(new Date());
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");
    const raw = Buffer.from(entry.data);
    const deflated = zlib.deflateRawSync(raw);
    const compressed = deflated.length < raw.length ? deflated : raw;
    const method = compressed === raw ? 0 : 8;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(now.time, 10); local.writeUInt16LE(now.date, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(method, 10);
    central.writeUInt16LE(now.time, 12); central.writeUInt16LE(now.date, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralData = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralData.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralData, end]);
}

function readZip(value) {
  const buffer = Buffer.from(value);
  const endOffset = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(endOffset + 10);
  if (count > MAX_ARCHIVE_ENTRIES) throw httpError(413, "Mod archive contains too many files.");
  let offset = buffer.readUInt32LE(endOffset + 16);
  let total = 0;
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (offset < 0 || offset + 46 > buffer.length) throw httpError(400, "Truncated ZIP central directory.");
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw httpError(400, "Invalid ZIP central directory.");
    const method = buffer.readUInt16LE(offset + 10);
    const expectedCrc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const rawSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8").replace(/\\/g, "/");
    offset += 46 + nameLength + extraLength + commentLength;
    if (!name || name.endsWith("/")) continue;
    validateArchiveName(name);
    if (![0, 8].includes(method)) throw httpError(400, `Unsupported ZIP compression method ${method}.`);
    if (rawSize > MAX_ARCHIVE_BYTES || total + rawSize > MAX_ARCHIVE_BYTES) throw httpError(413, "Expanded mod archive is too large.");
    if (localOffset + 30 > buffer.length) throw httpError(400, "Truncated ZIP local header.");
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw httpError(400, "Invalid ZIP local header.");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > buffer.length) throw httpError(400, `Truncated ZIP entry: ${name}`);
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? zlib.inflateRawSync(compressed) : Buffer.from(compressed);
    if (data.length !== rawSize || crc32(data) !== expectedCrc) throw httpError(400, `ZIP checksum failed for ${name}.`);
    total += data.length;
    if (total > MAX_ARCHIVE_BYTES) throw httpError(413, "Expanded mod archive is too large.");
    entries.push({ name, data });
  }
  return entries;
}

function findEndOfCentralDirectory(buffer) {
  for (let offset = buffer.length - 22, minimum = Math.max(0, buffer.length - 65557); offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw httpError(400, "Invalid ZIP archive.");
}

function stripArchiveRoot(entries) {
  if (entries.some((entry) => entry.name === "mod.json")) return entries;
  const manifest = entries.find((entry) => /^[^/]+\/mod\.json$/.test(entry.name));
  if (!manifest) return entries;
  const prefix = manifest.name.slice(0, manifest.name.indexOf("/") + 1);
  return entries.filter((entry) => entry.name.startsWith(prefix)).map((entry) => ({ ...entry, name: entry.name.slice(prefix.length) }));
}

function validateArchiveName(name) {
  if (path.posix.isAbsolute(name) || name.split("/").some((part) => !part || part === "." || part === "..")) throw httpError(400, `Unsafe archive path: ${name}`);
}

function resolveArchiveFile(root, name) {
  validateArchiveName(name);
  const target = path.resolve(root, ...name.split("/"));
  if (!isInside(root, target)) throw httpError(403, "Archive path leaves the mod project.");
  return target;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

module.exports = { SCHEMA_VERSION, createModProjectStore };
