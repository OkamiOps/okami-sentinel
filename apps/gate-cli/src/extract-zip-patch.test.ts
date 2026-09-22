import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const scannerEntry = require.resolve("@openai/codex-security");
const extractZip = require(
  require.resolve("extract-zip", { paths: [path.dirname(scannerEntry)] }),
) as (zipPath: string, options: { dir: string }) => Promise<void>;

test("the patched extract-zip rejects traversal and symbolic-link archives", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-extract-zip-"));
  const destination = path.join(root, "destination");
  const outside = path.join(root, "outside.txt");

  for (const archive of [
    zip([{ name: "../outside.txt", content: "escape" }]),
    zip([
      { name: "link", content: "../outside.txt", mode: 0o120777 },
      { name: "link/payload.txt", content: "escape" },
    ]),
    zip([
      { name: "redirect", content: "../outside.txt", mode: 0o120777 },
      { name: "redirect", content: "escape" },
    ]),
  ]) {
    const archivePath = path.join(root, `${Math.random()}.zip`);
    fs.writeFileSync(archivePath, archive);
    await assert.rejects(extractZip(archivePath, { dir: destination }));
    assert.equal(fs.existsSync(outside), false);
    assert.equal(fs.existsSync(path.join(destination, "link")), false);
    assert.equal(fs.existsSync(path.join(destination, "redirect")), false);
  }
});

test("the patched extract-zip still extracts ordinary files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-extract-zip-safe-"));
  const archivePath = path.join(root, "safe.zip");
  const destination = path.join(root, "destination");
  fs.writeFileSync(archivePath, zip([{ name: "nested/result.txt", content: "safe" }]));

  await extractZip(archivePath, { dir: destination });
  assert.equal(fs.readFileSync(path.join(destination, "nested", "result.txt"), "utf8"), "safe");
});

test("the patched extract-zip refuses pre-existing symlink ancestors and duplicate files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-extract-zip-existing-link-"));
  const destination = path.join(root, "destination");
  const outside = path.join(root, "outside");
  fs.mkdirSync(destination);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(destination, "linked"));

  const ancestorArchive = path.join(root, "ancestor.zip");
  fs.writeFileSync(ancestorArchive, zip([{ name: "linked/escaped.txt", content: "escape" }]));
  await assert.rejects(extractZip(ancestorArchive, { dir: destination }));
  assert.equal(fs.existsSync(path.join(outside, "escaped.txt")), false);

  const duplicateArchive = path.join(root, "duplicate.zip");
  fs.writeFileSync(duplicateArchive, zip([
    { name: "duplicate.txt", content: "first" },
    { name: "duplicate.txt", content: "second" },
  ]));
  await assert.rejects(extractZip(duplicateArchive, { dir: destination }));
  assert.equal(fs.readFileSync(path.join(destination, "duplicate.txt"), "utf8"), "first");
});

function zip(entries: Array<{ name: string; content: string; mode?: number }>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const content = Buffer.from(entry.content);
    const crc = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, content);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE((3 << 8) | 20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(content.length, 20);
    header.writeUInt32LE(content.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + content.length;
  }

  const centralData = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralData.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralData, end]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
