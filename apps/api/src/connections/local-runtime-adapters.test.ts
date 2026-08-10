import assert from "node:assert/strict";
import test from "node:test";
import { SecretRedactor } from "../redaction.js";
import type { StoredProviderConnection } from "../connections-store.js";

import {
  createLocalRuntimeAdapter,
  createLocalRouteAdapters,
} from "./local-runtime-adapters.js";
import { createRouteRegistry } from "./route-registry.js";
import { createRuntimeCommand } from "./runtime-command.js";

function connection(
  routeKind: string,
  protocol: StoredProviderConnection["protocol"] = "grok-build-cli",
): StoredProviderConnection {
  return {
    id: "conn-1",
    scopeId: "local" as const,
    name: "Local runtime",
    providerKind: "fixture",
    routeKind,
    transport: "local-cli" as const,
    authKind: "existing-session" as const,
    protocol,
    status: "ready" as const,
    modelSelectionMode: "catalog" as const,
    defaultModelId: null,
    lastTestedAt: null,
    lastModelSyncAt: null,
    modelCatalogStale: false,
    display: {
      providerLabel: "Fixture",
      routeLabel: "Fixture runtime",
      secretConfigured: false,
      endpointConfigured: false,
      endpointKind: null,
    },
    credentialRef: null,
  };
}

test("Grok catalog uses JSON only when runtime help advertises it", async () => {
  const calls: string[][] = [];
  const adapter = createLocalRuntimeAdapter({
    execFile: async (bin, args) => {
      calls.push([bin, ...args]);
      return args.at(-1) === "--help"
        ? { stdout: "Usage: grok models", stderr: "" }
        : { stdout: "human table", stderr: "" };
    },
  });

  const result = await adapter.discoverModels(connection("xai-grok-build-local"));

  assert.deepEqual(calls, [["grok", "models", "--help"], ["grok", "models"]]);
  assert.equal(result.safeError?.code, "model_discovery_unsupported");
});

test("runtime commands use execFile with an approved cwd, bounded output, and redaction", async () => {
  const calls: Array<{ binary: string; args: string[]; options: Record<string, unknown> }> = [];
  const redactor = new SecretRedactor();
  redactor.register("test/runtime", ["runtime-command-secret-marker"]);
  const command = createRuntimeCommand({
    approvedCwds: ["/sentinel"],
    redactor,
    execFile: async (binary, args, options) => {
      calls.push({ binary, args, options: options as unknown as Record<string, unknown> });
      return {
        stdout: "models runtime-command-secret-marker",
        stderr: "",
      };
    },
  });

  const output = await command.execute({
    binary: "grok",
    argv: ["models", "--json"],
    cwd: "/sentinel/project",
  });

  assert.equal(output.stdout.includes("runtime-command-secret-marker"), false);
  assert.deepEqual(calls, [{
    binary: "grok",
    args: ["models", "--json"],
    options: {
      cwd: "/sentinel/project",
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
      shell: false,
      windowsHide: true,
    },
  }]);
});

test("runtime command rejects command strings, shell mode, arbitrary config, and cwd escapes", async () => {
  const command = createRuntimeCommand({
    approvedCwds: ["/sentinel"],
    execFile: async () => ({ stdout: "", stderr: "" }),
  });

  for (const input of [
    { binary: "grok", argv: "models --json", cwd: "/sentinel" },
    { binary: "grok", argv: ["--config", "model=secret"], cwd: "/sentinel" },
    { binary: "grok", argv: ["models"], cwd: "/outside" },
    { binary: "grok", argv: ["models"], cwd: "/sentinel", shell: true },
  ]) {
    await assert.rejects(command.execute(input as never), { code: "protocol_unsupported" });
  }
});

test("Grok parses only runtime-advertised JSON and never infers a model from a table", async () => {
  const calls: string[][] = [];
  const adapter = createLocalRuntimeAdapter({
    execFile: async (bin, args) => {
      calls.push([bin, ...args]);
      return args.at(-1) === "--help"
        ? { stdout: "Usage: grok models [--json]", stderr: "" }
        : { stdout: JSON.stringify({ models: [{ id: "runtime-visible-grok" }] }), stderr: "" };
    },
  });

  const result = await adapter.discoverModels(connection("xai-grok-build-local"));

  assert.deepEqual(calls, [["grok", "models", "--help"], ["grok", "models", "--json"]]);
  assert.deepEqual(result.models.map((model) => model.id), ["runtime-visible-grok"]);
  assert.equal(result.safeError, undefined);
});

test("local inspection handles missing and unsupported runtimes with safe errors", async () => {
  const missing = createLocalRuntimeAdapter({
    execFile: async () => {
      const error = Object.assign(new Error("spawn grok ENOENT secret-value"), { code: "ENOENT" });
      throw error;
    },
  });
  const unsupported = createLocalRuntimeAdapter({
    execFile: async () => ({ stdout: "grok unsupported runtime version", stderr: "" }),
  });

  assert.deepEqual(await missing.inspect(connection("xai-grok-build-local")), {
    available: false,
    reason: "runtime_missing",
    supportsRuntimeDefault: false,
  });
  assert.deepEqual(await unsupported.inspect(connection("xai-grok-build-local")), {
    available: false,
    reason: "runtime_version_unsupported",
    supportsRuntimeDefault: false,
  });
});

test("Claude is the only local route that offers runtime-default without a catalog", async () => {
  const calls: string[][] = [];
  const adapter = createLocalRuntimeAdapter({
    execFile: async (bin, args) => {
      calls.push([bin, ...args]);
      return { stdout: "Usage: claude models", stderr: "" };
    },
  });

  const result = await adapter.discoverModels(connection("claude-code-local", "claude-code-cli"));

  assert.deepEqual(calls, [["claude", "models", "--help"]]);
  assert.deepEqual(result.models, []);
  assert.equal(result.supportsRuntimeDefault, true);
  assert.equal(result.safeError, undefined);
});

test("Cursor uses only its documented status, login, and JSON catalog commands", async () => {
  const calls: string[][] = [];
  const adapter = createLocalRuntimeAdapter({
    execFile: async (bin, args) => {
      calls.push([bin, ...args]);
      if (args.at(-1) === "--help") return { stdout: "Usage: cursor-agent models [--json]", stderr: "" };
      if (args.includes("models")) return { stdout: JSON.stringify({ models: [{ id: "cursor-visible" }] }), stderr: "" };
      return { stdout: "ok", stderr: "" };
    },
  });
  const cursor = connection("cursor-agent-local", "cursor-agent-cli");

  await adapter.inspect(cursor);
  await adapter.startAuth(cursor, "browser-oauth");
  const result = await adapter.discoverModels(cursor);

  assert.deepEqual(calls, [
    ["cursor-agent", "--version"],
    ["cursor-agent", "status"],
    ["cursor-agent", "login"],
    ["cursor-agent", "models", "--help"],
    ["cursor-agent", "models", "--json"],
  ]);
  assert.deepEqual(result.models.map((model) => model.id), ["cursor-visible"]);
  assert.equal(calls.flat().some((value) => value.startsWith("--model")), false);
});

test("local route registry has fixed route contracts without a bundled model catalog", () => {
  const local = createLocalRuntimeAdapter({ execFile: async () => ({ stdout: "", stderr: "" }) });
  const registry = createRouteRegistry({ local });
  const adapters = createLocalRouteAdapters(local);

  assert.deepEqual(adapters.map((adapter) => adapter.routeKind), [
    "xai-grok-build-local",
    "claude-code-local",
    "cursor-agent-local",
  ]);
  assert.equal(registry.get("openai-codex-local")?.transport, "codex-app-server");
  assert.equal(registry.get("openai-chatgpt-app-server")?.protocol, "codex-app-server");
  assert.equal(JSON.stringify(registry.manifests).includes("defaultModel"), false);
  assert.equal(JSON.stringify(registry.manifests).includes("runtime-visible-grok"), false);
});
