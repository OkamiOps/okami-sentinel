import assert from "node:assert/strict";
import test from "node:test";
import { portableCodexSecurityWorkerEnvironment } from "./launch.js";
import { spawnSync } from "node:child_process";

test("Portable launch carries the managed Graphify location without provider secrets or preload hooks", () => {
  const env = portableCodexSecurityWorkerEnvironment({
    PATH: process.env.PATH, HOME: process.env.HOME,
    CSB_GRAPHIFY_BIN: "/opt/sentinel-engines/graphify/venv/bin/graphify",
    CSB_GRAPHIFY_INSTALL_DIR: "/isolated/runtime",
    OPENAI_API_KEY: "not-for-child", NODE_OPTIONS: "--require untrusted.js",
  });
  assert.equal(env.CSB_GRAPHIFY_BIN, "/opt/sentinel-engines/graphify/venv/bin/graphify");
  assert.equal(env.CSB_GRAPHIFY_INSTALL_DIR, "/isolated/runtime");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    "import {managedGraphifyExecutable} from './src/graphify/managed-graph.ts'; console.log(managedGraphifyExecutable())"],
    { cwd: new URL("../../", import.meta.url), env, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), env.CSB_GRAPHIFY_BIN);
});
