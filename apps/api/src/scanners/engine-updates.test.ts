import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createEngineUpdatesService,
  executeEngineUpdateCommand,
  EngineUpdateError,
  type EngineUpdateExec,
  type EngineUpdateExecOptions,
  type EngineUpdateFetch,
} from "./engine-updates.js";
import {
  getManagedRuntimeCommand,
  readManagedRuntimeManifest,
} from "./managed-runtime-store.js";

const MANTIS_HEAD = "a".repeat(40);
const VULNHUNTER_HEAD = "b".repeat(40);

interface Fixture {
  dataDir: string;
  service: ReturnType<typeof createEngineUpdatesService>;
  latest: { security: string; codex: string };
  state: {
    now: Date;
    blocked: "scan_active" | "update_in_progress" | null;
    explicitOverride: boolean;
    fallbackVersion: string | null;
    installFails: boolean;
    contractsValid: boolean;
    failUrls: Set<string>;
    installs: number;
    activations: number;
    releases: number;
    npmCalls: Array<{ args: string[]; options: EngineUpdateExecOptions }>;
  };
}

function fixture(t: test.TestContext): Fixture {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "csb-engine-updates-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const latest = { security: "1.2.3", codex: "2.3.4" };
  const state = {
    now: new Date("2026-09-08T12:00:00.000Z"),
    blocked: null as "scan_active" | "update_in_progress" | null,
    explicitOverride: false,
    fallbackVersion: null as string | null,
    installFails: false,
    contractsValid: true,
    failUrls: new Set<string>(),
    installs: 0,
    activations: 0,
    releases: 0,
    npmCalls: [] as Array<{ args: string[]; options: EngineUpdateExecOptions }>,
  };
  const fetch: EngineUpdateFetch = async (url) => {
    if (state.failUrls.has(url)) throw new Error("network unavailable");
    if (url.includes("codex-security")) return response({ latest: latest.security });
    if (url.includes("@openai%2Fcodex/")) return response({ latest: latest.codex });
    if (url.includes("google/mantis")) return response([{ sha: MANTIS_HEAD }]);
    if (url.includes("capitalone/vulnhunter")) return response([{ sha: VULNHUNTER_HEAD }]);
    throw new Error("unexpected URL");
  };
  const exec: EngineUpdateExec = async (binary, args, options) => {
    if (binary === "npm") {
      state.installs += 1;
      state.npmCalls.push({ args: [...args], options });
      if (state.installFails) return { stdout: "private registry token should not leave this test", stderr: "failed", exitCode: 1 };
      const prefix = args[args.indexOf("--prefix") + 1];
      const requested = args.at(-1)!;
      const split = requested.lastIndexOf("@");
      const packageId = requested.slice(0, split);
      const version = requested.slice(split + 1);
      const id = packageId === "@openai/codex-security" ? "codex-security" : "codex-cli";
      const entry = id === "codex-security"
        ? path.join(prefix, "node_modules", "@openai", "codex-security", "bin", "codex-security.mjs")
        : path.join(prefix, "node_modules", "@openai", "codex", "bin", "codex.js");
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(path.join(path.dirname(entry), "..", "package.json"), JSON.stringify({ name: packageId, version }));
      fs.writeFileSync(entry, "#!/usr/bin/env node\n", { mode: 0o700 });
      return { stdout: "installed", stderr: "", exitCode: 0 };
    }
    const entry = binary;
    const packageJson = path.join(path.dirname(entry), "..", "package.json");
    const version = JSON.parse(fs.readFileSync(packageJson, "utf8")).version as string;
    if (args.includes("--version")) return { stdout: `v${version}\n`, stderr: "", exitCode: 0 };
    if (!state.contractsValid) return { stdout: "unsupported legacy command", stderr: "", exitCode: 0 };
    if (entry.includes("codex-security")) {
      if (args.includes("--dry-run")) {
        const output = args[args.indexOf("--output-dir") + 1]!;
        // Model upstream's protected-root rule when DATA_DIR is in a checkout.
        const relative = path.relative(dataDir, output);
        if (relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
          return { stdout: "", stderr: "output is inside a protected Git worktree", exitCode: 2 };
        }
      }
      return { stdout: "--auth --model --mode --output-dir --json", stderr: "", exitCode: 0 };
    }
    if (args.includes("app-server")) return { stdout: "--stdio", stderr: "", exitCode: 0 };
    return { stdout: "--json --ephemeral --ignore-user-config --ignore-rules", stderr: "", exitCode: 0 };
  };
  const service = createEngineUpdatesService({
    dataDir,
    currentRuntime: async (id) => ({
      command: id === "codex-security" ? "npx" : "codex",
      source: id === "codex-security" ? "on-demand" : "external",
      version: state.fallbackVersion,
      explicitOverride: state.explicitOverride,
    }),
    acquireMaintenance: () => () => { state.releases += 1; },
    blockingReason: () => state.blocked,
    onActivated: () => { state.activations += 1; },
    fetch,
    exec,
    now: () => state.now,
  });
  return { dataDir, service, latest, state };
}

function response(value: unknown): { ok: true; text(): Promise<string> } {
  return { ok: true, text: async () => JSON.stringify(value) };
}

test("checks all fixed sources independently and marks only unavailable sources", async (t) => {
  const f = fixture(t);
  f.state.failUrls.add("https://registry.npmjs.org/-/package/@openai%2Fcodex/dist-tags");

  const status = await f.service.check();
  const security = status.items.find((item) => item.id === "codex-security")!;
  const codex = status.items.find((item) => item.id === "codex-cli")!;
  const mantis = status.items.find((item) => item.id === "mantis")!;

  assert.equal(security.latestVersion, "1.2.3");
  assert.equal(security.status, "available");
  assert.equal(codex.status, "unavailable");
  assert.equal(codex.error, "registry_unavailable");
  assert.equal(mantis.latestVersion, MANTIS_HEAD);
  assert.equal(mantis.status, "review_required");
  assert.equal(mantis.canUpdate, false);
});

test("a check does not claim persistence when the short maintenance lease is unavailable", async (t) => {
  const f = fixture(t);
  f.state.blocked = "scan_active";

  await assert.rejects(f.service.check(), (error: unknown) =>
    error instanceof EngineUpdateError && error.code === "scan_active",
  );
  assert.equal(fs.existsSync(path.join(f.dataDir, "engine-updates", "state.json")), false);
});

test("installs only a freshly checked exact version, activates it, and rolls back the prior verified version", async (t) => {
  const f = fixture(t);
  await f.service.check();
  await f.service.update("codex-security", "1.2.3");
  assert.deepEqual(getManagedRuntimeCommand(f.dataDir, "codex-security")?.version, "1.2.3");

  f.latest.security = "1.2.4";
  f.state.now = new Date("2026-09-08T12:01:00.000Z");
  await f.service.check();
  const updated = await f.service.update("codex-security", "1.2.4");
  const runtime = updated.items.find((item) => item.id === "codex-security")!;
  assert.equal(runtime.source, "managed");
  assert.equal(runtime.currentVersion, "1.2.4");
  assert.equal(runtime.previousVersion, "1.2.3");

  const rolledBack = await f.service.rollback("codex-security");
  assert.equal(rolledBack.items.find((item) => item.id === "codex-security")!.currentVersion, "1.2.3");
  assert.equal(getManagedRuntimeCommand(f.dataDir, "codex-security")?.version, "1.2.3");
  assert.equal(f.state.activations, 3);
  assert.equal(f.state.releases, 5);

  const npm = f.state.npmCalls.at(-1)!;
  assert.deepEqual(npm.args.slice(2, 8), ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "--registry=https://registry.npmjs.org"]);
  assert.equal(npm.args.at(-1), "@openai/codex-security@1.2.4");
  assert.equal(npm.options.env.NODE_OPTIONS, undefined);
  assert.equal(npm.options.env.npm_config__authToken, undefined);
  assert.equal(npm.options.env.NPM_CONFIG_IGNORE_SCRIPTS, "true");
  assert.equal(npm.options.env.PATH, process.env.PATH ?? "");
});

test("a failed installation leaves the old managed selection intact and records only a safe error code", async (t) => {
  const f = fixture(t);
  await f.service.check();
  await f.service.update("codex-security", "1.2.3");
  f.latest.security = "1.2.4";
  f.state.now = new Date("2026-09-08T12:01:00.000Z");
  await f.service.check();
  f.state.installFails = true;

  await assert.rejects(f.service.update("codex-security", "1.2.4"), (error: unknown) =>
    error instanceof EngineUpdateError && error.code === "install_failed",
  );
  assert.equal(getManagedRuntimeCommand(f.dataDir, "codex-security")?.version, "1.2.3");
  const state = readManagedRuntimeManifest(f.dataDir);
  assert.deepEqual(state.lastOperation && {
    action: state.lastOperation.action,
    status: state.lastOperation.status,
    version: state.lastOperation.version,
    error: state.lastOperation.error,
  }, { action: "update", status: "failed", version: "1.2.4", error: "install_failed" });
});

test("rejects a package whose CLI lacks Sentinel's required command contracts", async (t) => {
  const f = fixture(t);
  await f.service.check();
  await f.service.update("codex-security", "1.2.3");
  f.latest.security = "1.2.4";
  f.state.now = new Date("2026-09-08T12:01:00.000Z");
  await f.service.check();
  f.state.contractsValid = false;

  await assert.rejects(f.service.update("codex-security", "1.2.4"), (error: unknown) =>
    error instanceof EngineUpdateError && error.code === "verification_failed",
  );
  assert.equal(getManagedRuntimeCommand(f.dataDir, "codex-security")?.version, "1.2.3");
});

test("rejects stale and changed versions before npm runs", async (t) => {
  const f = fixture(t);
  await f.service.check();
  f.state.now = new Date("2026-09-08T12:06:00.001Z");
  await assert.rejects(f.service.update("codex-security", "1.2.3"), (error: unknown) =>
    error instanceof EngineUpdateError && error.code === "check_required",
  );
  assert.equal(f.state.installs, 0);

  f.state.now = new Date("2026-09-08T12:07:00.000Z");
  await f.service.check();
  await assert.rejects(f.service.update("codex-security", "1.2.4"), (error: unknown) =>
    error instanceof EngineUpdateError && error.code === "version_changed",
  );
  assert.equal(f.state.installs, 0);
});

test("explicit command overrides and active scans block before any install", async (t) => {
  const f = fixture(t);
  await f.service.check();
  f.state.explicitOverride = true;
  await assert.rejects(f.service.update("codex-security", "1.2.3"), (error: unknown) =>
    error instanceof EngineUpdateError && error.code === "external_runtime",
  );
  f.state.explicitOverride = false;
  f.state.blocked = "scan_active";
  await assert.rejects(f.service.update("codex-security", "1.2.3"), (error: unknown) =>
    error instanceof EngineUpdateError && error.code === "scan_active",
  );
  assert.equal(f.state.installs, 0);
});

test("the checked latest external runtime can still be installed into Sentinel management", async (t) => {
  const f = fixture(t);
  f.state.fallbackVersion = "1.2.3";
  const checked = await f.service.check();
  const item = checked.items.find((entry) => entry.id === "codex-security")!;
  assert.equal(item.status, "current");
  assert.equal(item.canUpdate, true);

  await f.service.update("codex-security", "1.2.3");
  assert.equal(getManagedRuntimeCommand(f.dataDir, "codex-security")?.version, "1.2.3");
});

test("forged runtime manifest paths are rejected and never become an executable command", async (t) => {
  const f = fixture(t);
  const updates = path.join(f.dataDir, "engine-updates");
  fs.mkdirSync(updates, { recursive: true });
  fs.writeFileSync(path.join(updates, "state.json"), JSON.stringify({
    schemaVersion: 1,
    runtimes: {
      "codex-security": {
        active: { version: "1.2.3", relativePath: "../../outside" },
        previous: null,
      },
    },
    checks: {},
    lastOperation: null,
  }));

  assert.equal(getManagedRuntimeCommand(f.dataDir, "codex-security"), null);
  const status = await f.service.status();
  const item = status.items.find((entry) => entry.id === "codex-security")!;
  assert.equal(item.error, "state_invalid");
  await assert.rejects(f.service.update("codex-security", "1.2.3"), (error: unknown) =>
    error instanceof EngineUpdateError && error.code === "state_invalid",
  );
});

test("native updater execution force-closes a child that ignores TERM", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    executeEngineUpdateCommand(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);"], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      timeout: 100,
      maxBuffer: 1_024,
      shell: false,
      windowsHide: true,
    }),
    (error: unknown) => typeof error === "object" && error !== null &&
      (error as { code?: unknown }).code === "engine_update_timeout",
  );
  assert.ok(Date.now() - startedAt < 1_500);
});
