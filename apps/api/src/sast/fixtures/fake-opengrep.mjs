#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("2.0.0");
} else {
  const config = JSON.parse(fs.readFileSync(args[args.indexOf("--config") + 1], "utf8"));
  if (config.calls) fs.appendFileSync(config.calls, "scan\n");
  if (config.mode === "timeout") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
    fs.writeFileSync(config.pidFile, String(child.pid));
    setInterval(() => {}, 1000);
  } else if (config.mode === "bad-json") console.log("not json");
  else if (config.mode === "nonzero") { console.error("secret must not be persisted"); process.exitCode = 2; }
  else {
    console.log(JSON.stringify({ version: "2.0.0", rules: ["fixture"], errors: [], results: config.mode === "empty" ? [] : [{
      check_id: "sentinel-test", path: path.join(args.at(-1), "source.ts"),
      start: { line: 1, col: 1 }, end: { line: 1, col: 12 },
      extra: { severity: "ERROR", message: "Review dynamic code", lines: "eval(input)", metadata: { cwe: ["CWE-95"] } },
    }] }));
  }
}
