import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { opengrepConfiguration } from "../config.js";

test("authored pack detects unsafe fixtures and excludes safe alternatives", (t) => {
  const config = opengrepConfiguration();
  const probe = spawnSync(config.binary, ["--version"], { encoding: "utf8" });
  if ((probe.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") { t.skip("OpenGrep binary absent"); return; }
  assert.equal(probe.status, 0, probe.stderr);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-rules-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixtures: Record<string, string> = {
    "unsafe.ts": [
      "eval(input);", "new Function(input);", "child_process.exec(input);", "spawn(cmd, [], {shell: true});",
      'db.query("SELECT " + input);', 'db.query(`SELECT ${input}`);', "https.request({rejectUnauthorized: false});",
      'crypto.createHash("md5").update(password);', "el.innerHTML = input;",
      "const html = {dangerouslySetInnerHTML: {__html: input}};", 'const key = "AKIAABCDEFGHIJKLMNOP";',
      'const pem = "-----BEGIN PRIVATE KEY-----";',
    ].join("\n"),
    "unsafe.py": ["import subprocess, requests, pickle, yaml, hashlib", "eval(code)", "subprocess.run(cmd, shell=True)",
      'db.execute("SELECT " + value)', "requests.get(url, verify=False)", "hashlib.sha1(password)", "pickle.loads(data)", "yaml.load(data)"].join("\n"),
    "unsafe.go": ['package main', 'import ("crypto/tls"; "crypto/md5"; "database/sql")', 'func unsafe(db *sql.DB, input string, password string) {',
      'db.Query("SELECT " + input)', '_ = tls.Config{InsecureSkipVerify: true}', '_ = md5.Sum([]byte(password))', '}'].join("\n"),
    "safe.ts": ['eval("1+1");', 'new Function("return 1");', 'exec("ls");', 'db.query("SELECT ?", [input]);',
      'https.request({rejectUnauthorized: true});', 'el.innerHTML = "constant";', 'crypto.createHash("sha256").update(password);'].join("\n"),
    "safe.py": ['import subprocess, requests, yaml', 'subprocess.run(["ls"], shell=False)', 'requests.get(url, verify=True)',
      'yaml.safe_load(data)', 'yaml.load(data, Loader=yaml.SafeLoader)', 'db.execute("SELECT ?", (value,))'].join("\n"),
    "safe.go": ['package main', 'import "crypto/tls"', 'var c = tls.Config{InsecureSkipVerify: false}'].join("\n"),
  };
  for (const [name, content] of Object.entries(fixtures)) fs.writeFileSync(path.join(root, name), content);
  const scan = spawnSync(config.binary, ["scan", "--json", "--config", config.rules[0], root], { encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(scan.status, 0, scan.stdout + scan.stderr);
  const output = JSON.parse(scan.stdout);
  assert.deepEqual(output.errors, []);
  assert.ok(output.results.length > 0);
  assert.ok(output.results.every((finding: { path: string }) => path.basename(finding.path).startsWith("unsafe.")));
  const ids = new Set(output.results.map((finding: { check_id: string }) => finding.check_id.split(".").at(-1)));
  const rules = fs.readFileSync(config.rules[0] + "/sentinel.yaml", "utf8").matchAll(/  - id: (.+)/g);
  for (const [, id] of rules) assert.ok(ids.has(id), `missing fixture match: ${id}`);
});
