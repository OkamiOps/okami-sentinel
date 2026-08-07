import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createGhRunner } from "./github-cli.js";

test("runs gh-compatible commands with argv, cwd and stdin without a shell", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "csb-gh-runner-"));
  const runner = createGhRunner(process.execPath);

  try {
    const result = await runner(
      [
        "-e",
        "process.stdin.setEncoding('utf8');let body='';process.stdin.on('data',(chunk)=>body+=chunk);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({cwd:process.cwd(),body}));process.stderr.write('diagnostic');process.exitCode=7;});",
      ],
      { cwd, stdin: "payload" },
    );

    assert.deepEqual(JSON.parse(result.stdout), {
      cwd: fs.realpathSync(cwd),
      body: "payload",
    });
    assert.equal(result.stderr, "diagnostic");
    assert.equal(result.exitCode, 7);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
