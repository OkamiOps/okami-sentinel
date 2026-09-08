import fs from "node:fs";
import path from "node:path";

const VOLUME_ROOT = "/var/lib/sentinel";
const APP_UID = 1000;
const APP_GID = 1000;
const DIRECTORIES = [
  "data",
  "home",
  "tmp",
  "codex-home",
  "codex-security-state",
];

if (typeof process.getuid === "function" && process.getuid() !== 0) {
  throw new Error("volume initialization must run as root");
}

assertDirectory(VOLUME_ROOT);
process.umask(0o077);

for (const relativePath of DIRECTORIES) {
  const target = path.join(VOLUME_ROOT, relativePath);
  if (path.dirname(target) !== VOLUME_ROOT) {
    throw new Error(`invalid volume directory: ${relativePath}`);
  }
  ensurePrivateAppDirectory(target);
}

function assertDirectory(target) {
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`volume root is not a directory: ${target}`);
  }
}

function ensurePrivateAppDirectory(target) {
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`volume path is not a directory: ${target}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    fs.mkdirSync(target, { mode: 0o700 });
  }

  // Apply ownership and mode to this fixed top-level directory only. Existing
  // database, evidence, cache, and runtime trees are never traversed or chown'd.
  fs.chownSync(target, APP_UID, APP_GID);
  fs.chmodSync(target, 0o700);
}
