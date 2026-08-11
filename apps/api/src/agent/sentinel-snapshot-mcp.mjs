import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_PATH_BYTES = 2 * 1024;
const MAX_READ_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 128 * 1024;
const MAX_LIST_ENTRIES = 256;
const MAX_SEARCH_FILES = 256;
const MAX_SEARCH_FILE_BYTES = 64 * 1024;
const MAX_SEARCH_MATCHES = 100;
const MAX_SEARCH_QUERY_BYTES = 1 * 1024;
const MAX_WALK_DEPTH = 32;
const PROTOCOL_VERSION = "2025-06-18";
const ACCESS_DENIED = { code: "snapshot_access_denied" };
const RESULT_LIMIT = { code: "snapshot_result_limit" };
const TOOL_UNAVAILABLE = { code: "snapshot_tool_unavailable" };

// The fixed `/usr/bin/env -i` launcher must deliver no inherited variables. macOS
// injects this non-secret encoding value even for `env -i`; everything else fails closed.
if (Object.keys(process.env).some((name) => name !== "__CF_USER_TEXT_ENCODING")) process.exit(78);

const { root, audit } = initializeMcp(process.argv.slice(2));
const tools = [
  {
    name: "list",
    description: "List one directory in the pinned read-only Sentinel snapshot.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { path: { type: "string" } },
    },
  },
  {
    name: "read",
    description: "Read one bounded text file from the pinned read-only Sentinel snapshot.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: { path: { type: "string" } },
    },
  },
  {
    name: "search",
    description: "Search bounded text files in the pinned read-only Sentinel snapshot.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        path: { type: "string" },
        query: { type: "string" },
      },
    },
  },
];

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (Buffer.byteLength(line, "utf8") > MAX_REQUEST_BYTES) return;
  const request = parseRequest(line);
  if (request === null) return;
  handle(request);
});

function initializeMcp(argv) {
  if (argv.length !== 3) process.exit(78);
  const root = initializeSnapshotRoot(argv[0]);
  const audit = initializeAudit(argv[1], argv[2], root);
  return { root, audit };
}

function initializeSnapshotRoot(configured) {
  if (typeof configured !== "string" || configured.includes("\0")) process.exit(78);
  if (!path.isAbsolute(configured)) process.exit(78);
  const absolute = path.resolve(configured);
  try {
    const metadata = fs.lstatSync(absolute);
    const canonical = fs.realpathSync(absolute);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      absolute !== canonical ||
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      !Number.isSafeInteger(uid) ||
      metadata.uid !== uid ||
      (metadata.mode & 0o077) !== 0 ||
      (metadata.mode & 0o222) !== 0
    ) process.exit(78);
    return {
      absolute,
      canonical,
      dev: String(metadata.dev),
      ino: String(metadata.ino),
      uid: metadata.uid,
      mode: metadata.mode & 0o777,
    };
  } catch {
    process.exit(78);
  }
}

function initializeAudit(configuredPath, nonce, snapshotRoot) {
  if (
    typeof configuredPath !== "string" ||
    configuredPath.includes("\0") ||
    !path.isAbsolute(configuredPath) ||
    !/^[a-f0-9]{64}$/.test(nonce)
  ) process.exit(78);
  const absolute = path.resolve(configuredPath);
  const directory = path.dirname(absolute);
  try {
    const metadata = fs.lstatSync(directory);
    const canonical = fs.realpathSync(directory);
    if (
      directory !== canonical ||
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      metadata.uid !== snapshotRoot.uid ||
      (metadata.mode & 0o077) !== 0 ||
      !/^\.sentinel-mcp-audit-[a-f0-9]{64}\.json$/.test(path.basename(absolute)) ||
      fs.existsSync(absolute) ||
      inside(snapshotRoot.canonical, absolute)
    ) process.exit(78);
    return {
      absolute,
      directory,
      dev: String(metadata.dev),
      ino: String(metadata.ino),
      uid: metadata.uid,
      mode: metadata.mode & 0o777,
      nonce,
      recorded: false,
    };
  } catch {
    process.exit(78);
  }
}

function handle(request) {
  if (request.method === "notifications/initialized") return;
  if (request.method === "initialize") {
    send(request.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "sentinel-snapshot", version: "1" },
    });
    return;
  }
  if (request.method === "tools/list") {
    send(request.id, { tools });
    return;
  }
  if (request.method === "tools/call") {
    const called = isRecord(request.params) ? request.params : {};
    const name = called.name;
    const args = isRecord(called.arguments) ? called.arguments : {};
    try {
      let result;
      if (name === "list") {
        result = list(args);
        recordToolCall();
      } else if (name === "read") {
        result = read(args);
        recordToolCall();
      } else if (name === "search") {
        result = search(args);
        recordToolCall();
      }
      else throw TOOL_UNAVAILABLE;
      send(request.id, { content: [{ type: "text", text: boundedJson(result) }] });
    } catch (error) {
      const code = error === RESULT_LIMIT ? RESULT_LIMIT : error === TOOL_UNAVAILABLE ? TOOL_UNAVAILABLE : ACCESS_DENIED;
      send(request.id, { content: [{ type: "text", text: JSON.stringify(code) }], isError: true });
    }
    return;
  }
  if (request.id !== undefined) {
    sendError(request.id, -32601);
  }
}

function recordToolCall() {
  if (audit.recorded) return;
  validateAuditDirectory();
  fs.writeFileSync(audit.absolute, `${audit.nonce}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const metadata = fs.lstatSync(audit.absolute);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.uid !== audit.uid ||
    (metadata.mode & 0o077) !== 0 ||
    fs.readFileSync(audit.absolute, "utf8") !== `${audit.nonce}\n`
  ) throw ACCESS_DENIED;
  audit.recorded = true;
}

function validateAuditDirectory() {
  const metadata = fs.lstatSync(audit.directory);
  const canonical = fs.realpathSync(audit.directory);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    canonical !== audit.directory ||
    String(metadata.dev) !== audit.dev ||
    String(metadata.ino) !== audit.ino ||
    metadata.uid !== audit.uid ||
    (metadata.mode & 0o777) !== audit.mode ||
    (metadata.mode & 0o077) !== 0
  ) throw ACCESS_DENIED;
}

function list(args) {
  requireOnly(args, ["path"]);
  const relative = args.path === undefined ? "." : relativePath(args.path, true);
  const target = resolveInside(relative, "directory");
  const entries = [];
  for (const entry of fs.readdirSync(target.absolute, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (entries.length >= MAX_LIST_ENTRIES) throw RESULT_LIMIT;
    if (entry.isSymbolicLink()) continue;
    const childRelative = relative === "." ? entry.name : `${relative}/${entry.name}`;
    const child = resolveInside(childRelative, "any");
    if (child.metadata.isDirectory()) entries.push({ path: childRelative, kind: "directory", size: 0 });
    else if (child.metadata.isFile()) entries.push({ path: childRelative, kind: "file", size: child.metadata.size });
  }
  validateRoot();
  return { path: relative, entries };
}

function read(args) {
  requireOnly(args, ["path"]);
  const relative = relativePath(args.path, false);
  const target = resolveInside(relative, "file");
  if (target.metadata.size > MAX_READ_BYTES) throw RESULT_LIMIT;
  const bytes = fs.readFileSync(target.absolute);
  if (bytes.byteLength > MAX_READ_BYTES || bytes.includes(0)) throw RESULT_LIMIT;
  validateRoot();
  return { path: relative, content: bytes.toString("utf8"), truncated: false };
}

function search(args) {
  requireOnly(args, ["path", "query"]);
  if (typeof args.query !== "string" || args.query.length === 0 ||
    args.query.includes("\0") || Buffer.byteLength(args.query, "utf8") > MAX_SEARCH_QUERY_BYTES) {
    throw ACCESS_DENIED;
  }
  const relative = args.path === undefined ? "." : relativePath(args.path, true);
  const target = resolveInside(relative, "directory");
  const files = [];
  collectFiles(relative, target.absolute, files, 0);
  const matches = [];
  for (const file of files) {
    const current = resolveInside(file, "file");
    if (current.metadata.size > MAX_SEARCH_FILE_BYTES) throw RESULT_LIMIT;
    const bytes = fs.readFileSync(current.absolute);
    if (bytes.byteLength > MAX_SEARCH_FILE_BYTES || bytes.includes(0)) throw RESULT_LIMIT;
    const lines = bytes.toString("utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].includes(args.query)) continue;
      if (matches.length >= MAX_SEARCH_MATCHES) throw RESULT_LIMIT;
      const text = lines[index].slice(0, 1_024);
      matches.push({ path: file, line: index + 1, text });
    }
  }
  validateRoot();
  return { query: args.query, matches };
}

function collectFiles(relative, absolute, files, depth) {
  if (depth > MAX_WALK_DEPTH) throw RESULT_LIMIT;
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (files.length >= MAX_SEARCH_FILES) throw RESULT_LIMIT;
    if (entry.isSymbolicLink()) continue;
    const childRelative = relative === "." ? entry.name : `${relative}/${entry.name}`;
    const child = resolveInside(childRelative, "any");
    if (child.metadata.isDirectory()) collectFiles(childRelative, child.absolute, files, depth + 1);
    else if (child.metadata.isFile()) files.push(childRelative);
  }
}

function resolveInside(relative, expected) {
  validateRoot();
  const segments = relative === "." ? [] : relative.split("/");
  let candidate = root.absolute;
  for (const segment of segments) {
    candidate = path.join(candidate, segment);
    const metadata = fs.lstatSync(candidate);
    if (metadata.isSymbolicLink() || !immutableMetadata(metadata)) throw ACCESS_DENIED;
    const canonical = fs.realpathSync(candidate);
    if (!inside(root.canonical, canonical)) throw ACCESS_DENIED;
  }
  const metadata = fs.lstatSync(candidate);
  if (
    metadata.isSymbolicLink() ||
    (expected === "file" && !metadata.isFile()) ||
    (expected === "directory" && !metadata.isDirectory())
  ) throw ACCESS_DENIED;
  return { absolute: candidate, metadata };
}

function validateRoot() {
  const metadata = fs.lstatSync(root.absolute);
  const canonical = fs.realpathSync(root.absolute);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    canonical !== root.canonical ||
    String(metadata.dev) !== root.dev ||
    String(metadata.ino) !== root.ino ||
    metadata.uid !== root.uid ||
    (metadata.mode & 0o777) !== root.mode ||
    (metadata.mode & 0o077) !== 0 ||
    (metadata.mode & 0o222) !== 0
  ) throw ACCESS_DENIED;
}

function relativePath(value, allowRoot) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES || path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw ACCESS_DENIED;
  }
  if (value === "." && allowRoot) return ".";
  const segments = value.split(/[\\/]/);
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) throw ACCESS_DENIED;
  return segments.join("/");
}

function requireOnly(value, allowed) {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw ACCESS_DENIED;
}

function boundedJson(value) {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_RESULT_BYTES) throw RESULT_LIMIT;
  return serialized;
}

function parseRequest(line) {
  try {
    const value = JSON.parse(line);
    if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") return null;
    if (value.id !== undefined && (!Number.isSafeInteger(value.id) || value.id < 0)) return null;
    return value;
  } catch {
    return null;
  }
}

function send(id, result) {
  if (!Number.isSafeInteger(id)) return;
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function sendError(id, code) {
  if (!Number.isSafeInteger(id)) return;
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message: "request rejected" } })}\n`);
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function immutableMetadata(metadata) {
  return metadata.uid === root.uid && (metadata.mode & 0o222) === 0;
}
