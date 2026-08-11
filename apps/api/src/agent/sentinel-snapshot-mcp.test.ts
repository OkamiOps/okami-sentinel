import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { SENTINEL_SNAPSHOT_MCP_ALLOWED_TOOLS } from "./defensive-local-cli.js";

interface JsonRpcResponse {
  id: number;
  result?: {
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
}

interface SnapshotMcp {
  call(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse>;
  close(): Promise<void>;
}

test("Sentinel snapshot MCP exposes only bounded read/list/search within its pinned immutable root", async (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-snapshot-mcp-"));
  const requestedSnapshot = path.join(fixture, "snapshot");
  const auditNonce = "a".repeat(64);
  const requestedSession = path.join(fixture, "session");
  fs.mkdirSync(path.join(requestedSnapshot, "src"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(requestedSession, { mode: 0o700 });
  const snapshot = fs.realpathSync(requestedSnapshot);
  const session = fs.realpathSync(requestedSession);
  const auditPath = path.join(session, `.sentinel-mcp-audit-${auditNonce}.json`);
  const outside = path.join(path.dirname(snapshot), "outside.txt");
  fs.writeFileSync(path.join(snapshot, "src", "app.ts"), "export const safe = true;\n", { mode: 0o400 });
  fs.writeFileSync(outside, "outside-secret\n", { mode: 0o600 });
  fs.symlinkSync(outside, path.join(snapshot, "outside-link"));
  fs.chmodSync(path.join(snapshot, "src"), 0o500);
  fs.chmodSync(snapshot, 0o500);
  const mcp = await startSnapshotMcp(snapshot, auditPath, auditNonce);
  t.after(async () => {
    await mcp.close();
    unlockFixture(fixture);
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  const tools = await mcp.call("tools/list");
  assert.deepEqual(
    (tools.result?.content ?? []).map((item) => item.text),
    [],
    "tools/list returns its MCP-native tools array rather than text content",
  );
  const listedTools = (tools.result as { tools: Array<{ name: string }> }).tools;
  assert.deepEqual(listedTools.map((tool) => tool.name), [
    "list",
    "read",
    "search",
  ]);
  assert.equal(
    listedTools.map((tool) => `mcp__sentinel_snapshot__${tool.name}`).join(","),
    SENTINEL_SNAPSHOT_MCP_ALLOWED_TOOLS,
  );

  const deniedBeforeAudit = await mcp.call("tools/call", {
    name: "read",
    arguments: { path: "../outside.txt" },
  });
  assert.equal(deniedBeforeAudit.result?.isError, true);
  assert.deepEqual(toolError(deniedBeforeAudit), { code: "snapshot_access_denied" });
  assert.equal(fs.existsSync(auditPath), false, "a denied call cannot attest to a snapshot read");

  const listed = await toolCall(mcp, "list", { path: "src" });
  assert.equal(fs.readFileSync(auditPath, "utf8"), `${auditNonce}\n`);
  assert.deepEqual(listed, {
    path: "src",
    entries: [{ path: "src/app.ts", kind: "file", size: 26 }],
  });
  const read = await toolCall(mcp, "read", { path: "src/app.ts" });
  assert.deepEqual(read, {
    path: "src/app.ts",
    content: "export const safe = true;\n",
    truncated: false,
  });
  const searched = await toolCall(mcp, "search", { query: "safe" });
  assert.deepEqual(searched, {
    query: "safe",
    matches: [{ path: "src/app.ts", line: 1, text: "export const safe = true;" }],
  });

  for (const unsafePath of ["../outside.txt", outside, "src/app.ts\u0000.json", "outside-link"]) {
    const failed = await mcp.call("tools/call", {
      name: "read",
      arguments: { path: unsafePath },
    });
    assert.equal(failed.result?.isError, true);
    assert.deepEqual(toolError(failed), { code: "snapshot_access_denied" });
  }

  fs.renameSync(snapshot, path.join(fixture, "swapped-snapshot"));
  fs.mkdirSync(snapshot, { mode: 0o700 });
  const swapped = await mcp.call("tools/call", {
    name: "list",
    arguments: { path: "." },
  });
  assert.equal(swapped.result?.isError, true);
  assert.deepEqual(toolError(swapped), { code: "snapshot_access_denied" });
});

async function startSnapshotMcp(snapshot: string, auditPath: string, auditNonce: string): Promise<SnapshotMcp> {
  const entry = fileURLToPath(new URL("./sentinel-snapshot-mcp.mjs", import.meta.url));
  const child = spawn("/usr/bin/env", ["-i", process.execPath, entry, snapshot, auditPath, auditNonce], {
    cwd: snapshot,
    env: { TEST_ONLY_SENTINEL_SECRET: "must-not-reach-mcp" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let lineBuffer = "";
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: JsonRpcResponse) => void; reject: (reason: Error) => void }>();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    lineBuffer += chunk;
    for (;;) {
      const newline = lineBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = lineBuffer.slice(0, newline);
      lineBuffer = lineBuffer.slice(newline + 1);
      const response = JSON.parse(line) as JsonRpcResponse;
      const waiter = pending.get(response.id);
      if (waiter) {
        pending.delete(response.id);
        waiter.resolve(response);
      }
    }
  });
  const call = (method: string, params?: Record<string, unknown>) => {
    const id = nextId++;
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP response timed out for ${method}`));
      }, 500);
      pending.set(id, {
        resolve: (response) => {
          clearTimeout(timeout);
          resolve(response);
        },
        reject,
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };
  await call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return {
    call,
    async close() {
      await closeChild(child);
    },
  };
}

async function toolCall(mcp: SnapshotMcp, name: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await mcp.call("tools/call", { name, arguments: args });
  assert.equal(response.result?.isError, undefined);
  return JSON.parse(response.result?.content?.[0]?.text ?? "");
}

function toolError(response: JsonRpcResponse): unknown {
  return JSON.parse(response.result?.content?.[0]?.text ?? "");
}

function unlockFixture(candidate: string): void {
  for (const entry of fs.readdirSync(candidate, { withFileTypes: true })) {
    const child = path.join(candidate, entry.name);
    if (entry.isDirectory()) {
      unlockFixture(child);
      fs.chmodSync(child, 0o700);
    } else if (!entry.isSymbolicLink()) {
      fs.chmodSync(child, 0o600);
    }
  }
  fs.chmodSync(candidate, 0o700);
}

async function closeChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([
    closed,
    new Promise<void>((resolve) => setTimeout(resolve, 250)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await closed;
}
