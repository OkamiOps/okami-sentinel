import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-server-runner-"));
process.env.CSB_RUNTIME_MODE = "server";
process.env.CSB_PUBLIC_ORIGIN = "https://sentinel.example";
process.env.CSB_DATA_DIR = path.join(root, "data");
process.env.CODEX_SECURITY_STATE_DIR = path.join(root, "state");
const { startScan } = await import("./runner.js");

test("server refuses legacy launches before capacity, CLI validation or credentials", async () => {
  let validated = false;
  try {
    await assert.rejects(startScan({ repositoryPath: root, engine: "codex-security" }, {
      dependencies: { validateScannerRequest: async () => { validated = true; throw new Error("unexpected CLI call"); } },
    }), /server_http_connection_required/);
    assert.equal(validated, false);
    assert.equal(fs.existsSync(path.join(root, "data")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
