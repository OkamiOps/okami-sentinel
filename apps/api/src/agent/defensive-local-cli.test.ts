import assert from "node:assert/strict";
import { execFile as nativeExecFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createDefensiveLocalCli,
  DefensiveLocalCliError,
  SENTINEL_SNAPSHOT_EMPTY_ENV_EXECUTABLE,
  type DefensiveLocalCliChild,
  type DefensiveLocalCliExecOptions,
} from "./defensive-local-cli.js";

test("Claude local execution uses the fixed defensive argv and strips API keys", async () => {
  const calls: Array<{ binary: string; argv: string[]; options: Record<string, unknown> }> = [];
  const runner = createDefensiveLocalCli({
    ...secureCwdDependency(),
    approvedCwds: ["/private/session"],
    environment: {
      PATH: "/usr/bin",
      OPENAI_API_KEY: "openai-secret",
      CODEX_API_KEY: "codex-secret",
      ANTHROPIC_API_KEY: "anthropic-secret",
      XAI_API_KEY: "xai-secret",
      CURSOR_API_KEY: "cursor-secret",
      PRESERVED_SESSION_VALUE: "session-only",
    },
    execFile: (binary, argv, options) => {
      calls.push({ binary, argv, options: options as unknown as Record<string, unknown> });
      return completedChild({ stdout: '{"findings":[]}', stderr: "" });
    },
  });

  const result = await runner.run({
    routeKind: "claude-code-local",
    cwd: "/private/session",
    snapshotRoot: "/private/snapshot",
    prompt: "Review the pinned snapshot only.",
    model: { kind: "catalog", id: "claude-sonnet-4" },
    modelCatalog: ["claude-sonnet-4"],
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["findings"],
      properties: { findings: { type: "array" } },
    },
    maxTurns: 3,
    signal: new AbortController().signal,
  });

  assert.deepEqual(result, { final: { findings: [] }, usage: null });
  const mcpConfig = calls[0]?.argv[3];
  assert.deepEqual(calls, [{
    binary: "claude",
    argv: [
      "--print",
      "--strict-mcp-config",
      "--mcp-config",
      mcpConfig,
      "--setting-sources",
      "local",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--permission-mode",
      "plan",
      "--tools",
      "",
      "--allowedTools",
      "mcp__sentinel_snapshot__list,mcp__sentinel_snapshot__read,mcp__sentinel_snapshot__search",
      "--max-turns",
      "3",
      "--output-format",
      "json",
      "--json-schema",
      '{"type":"object","additionalProperties":false,"required":["findings"],"properties":{"findings":{"type":"array"}}}',
      "--model",
      "claude-sonnet-4",
      "Review the pinned snapshot only.",
    ],
    options: {
      cwd: "/private/session",
      timeout: 60_000,
      maxBuffer: 524_288,
      shell: false,
      windowsHide: true,
      env: {
        PATH: "/usr/bin",
        PRESERVED_SESSION_VALUE: "session-only",
      },
      signal: calls[0]?.options.signal,
    },
  }]);
  assert.equal((calls[0]?.options.signal as AbortSignal).aborted, false);
});

test("Claude local execution disables every built-in and permits only the private Sentinel MCP tools", async () => {
  let argv: string[] | undefined;
  const runner = createDefensiveLocalCli({
    ...secureCwdDependency(),
    approvedCwds: ["/private/session"],
    environment: {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "must-not-reach-mcp",
      PRESERVED_SESSION_VALUE: "kept-for-claude-oauth",
    },
    execFile: (_binary, receivedArgv) => {
      argv = receivedArgv;
      return completedChild({ stdout: '{"findings":[]}', stderr: "" });
    },
  });

  await runner.run(claudeInput());

  assert.equal(argv?.includes("--bare"), false);
  assert.deepEqual(argv?.slice(argv.indexOf("--tools"), argv.indexOf("--max-turns")), [
    "--tools",
    "",
    "--allowedTools",
    "mcp__sentinel_snapshot__list,mcp__sentinel_snapshot__read,mcp__sentinel_snapshot__search",
  ]);
  const config = JSON.parse(argv?.[argv.indexOf("--mcp-config") + 1] ?? "") as {
    mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  };
  assert.deepEqual(Object.keys(config.mcpServers), ["sentinel_snapshot"]);
  assert.equal(config.mcpServers.sentinel_snapshot?.command, SENTINEL_SNAPSHOT_EMPTY_ENV_EXECUTABLE);
  assert.deepEqual(config.mcpServers.sentinel_snapshot?.args.slice(0, 2), ["-i", process.execPath]);
  assert.match(config.mcpServers.sentinel_snapshot?.args[2] ?? "", /sentinel-snapshot-mcp\.mjs$/);
  assert.equal(config.mcpServers.sentinel_snapshot?.args[3], "/private/snapshot");
  assert.match(config.mcpServers.sentinel_snapshot?.args[4] ?? "", /^\/private\/session\/\.sentinel-mcp-audit-[a-f0-9]{64}\.json$/);
  assert.match(config.mcpServers.sentinel_snapshot?.args[5] ?? "", /^[a-f0-9]{64}$/);
  assert.deepEqual(config.mcpServers.sentinel_snapshot?.env, {});
  assert.equal(JSON.stringify(config).includes("must-not-reach-mcp"), false);
});

test("Claude runs from a private empty session without safe-mode and exposes the snapshot only through explicit MCP", async () => {
  let argv: string[] | undefined;
  let cwd: string | undefined;
  const runner = createDefensiveLocalCli({
    ...secureCwdDependency(),
    approvedCwds: ["/private/session"],
    execFile: (_binary, receivedArgv, options) => {
      argv = receivedArgv;
      cwd = options.cwd;
      return completedChild({ stdout: '{"findings":[]}', stderr: "" });
    },
  });

  await runner.run(claudeInput());

  assert.equal(cwd, "/private/session");
  assert.equal(argv?.includes("--safe-mode"), false);
  assert.deepEqual(argv?.slice(argv.indexOf("--setting-sources"), argv.indexOf("--disable-slash-commands")), [
    "--setting-sources",
    "local",
  ]);
  const config = JSON.parse(argv?.[argv.indexOf("--mcp-config") + 1] ?? "") as {
    mcpServers: Record<string, { args: string[]; env: Record<string, string> }>;
  };
  assert.equal(config.mcpServers.sentinel_snapshot?.args[3], "/private/snapshot");
  assert.deepEqual(config.mcpServers.sentinel_snapshot?.env, {});
});

test("Grok local execution fails closed before discovered plugins or hooks can run", async () => {
  let calls = 0;
  const runner = createDefensiveLocalCli({
    ...secureCwdDependency(),
    approvedCwds: ["/private/session"],
    execFile: () => {
      calls += 1;
      return completedChild({ stdout: '{"findings":[]}', stderr: "" });
    },
  });

  await assert.rejects(
    runner.run({
      routeKind: "xai-grok-build-local",
      cwd: "/private/session",
      snapshotRoot: "/private/snapshot",
      prompt: "Inspect only the pinned files.",
      model: { kind: "catalog", id: "grok-4" },
      modelCatalog: ["grok-4"],
      jsonSchema: { type: "object" },
      maxTurns: 2,
      signal: new AbortController().signal,
    }),
    { code: "local_cli_isolation_unavailable" },
  );
  assert.equal(calls, 0);
});

test("local CLI rejects a JSON final that does not satisfy the requested schema", async () => {
  const runner = createDefensiveLocalCli({
    ...secureCwdDependency(),
    approvedCwds: ["/private/session"],
    execFile: () => completedChild({ stdout: '{"findings":"not-an-array"}', stderr: "" }),
  });

  await assert.rejects(
    runner.run({
      routeKind: "claude-code-local",
      cwd: "/private/session",
      snapshotRoot: "/private/snapshot",
      prompt: "Inspect only.",
      model: { kind: "runtime-default" },
      modelCatalog: [],
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["findings"],
        properties: { findings: { type: "array" } },
      },
      maxTurns: 1,
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof DefensiveLocalCliError && error.code === "agent_protocol_error",
  );
});

test("an external abort settles despite an uncooperative local CLI and consumes its late rejection", async () => {
  let rejectLate: ((reason?: unknown) => void) | undefined;
  let childSignal: AbortSignal | undefined;
  const killCalls: string[] = [];
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const runner = createDefensiveLocalCli({
    ...secureCwdDependency(),
    approvedCwds: ["/private/session"],
    killGraceMs: 1,
    closeTimeoutMs: 1,
    execFile: (_binary, _argv, options) => {
      childSignal = options.signal;
      markStarted?.();
      return {
        result: new Promise<{ stdout: string; stderr: string }>((_resolve, reject) => { rejectLate = reject; }),
        closed: new Promise<void>(() => undefined),
        kill(signal: string) {
          killCalls.push(signal);
          return true;
        },
      };
    },
  });
  const controller = new AbortController();
  const running = runner.run({ ...claudeInput(), signal: controller.signal });
  await started;
  controller.abort();

  const outcome = await settleAsCode(running, 250);
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  rejectLate?.(new Error("late CLI failure must not escape"));
  await assert.rejects(running, { code: "agent_termination_unconfirmed" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  process.off("unhandledRejection", onUnhandled);

  assert.equal(outcome, "agent_termination_unconfirmed");
  assert.equal(childSignal?.aborted, true);
  assert.deepEqual(killCalls, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(unhandled, []);
});

test("the local timeout settles despite an uncooperative local CLI and consumes its late rejection", async () => {
  let rejectLate: ((reason?: unknown) => void) | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const killCalls: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const runner = createDefensiveLocalCli({
    ...secureCwdDependency(),
    approvedCwds: ["/private/session"],
    killGraceMs: 1,
    closeTimeoutMs: 1,
    execFile: () => {
      markStarted?.();
      return {
        result: new Promise<{ stdout: string; stderr: string }>((_resolve, reject) => { rejectLate = reject; }),
        closed: new Promise<void>(() => undefined),
        kill(signal: string) {
          killCalls.push(signal);
          return true;
        },
      };
    },
  });
  const running = runner.run({ ...claudeInput(), timeoutMs: 10 });
  await started;

  const outcome = await settleAsCode(running, 50);
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  rejectLate?.(new Error("late CLI failure must not escape"));
  await assert.rejects(running, { code: "agent_termination_unconfirmed" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  process.off("unhandledRejection", onUnhandled);

  assert.equal(outcome, "agent_termination_unconfirmed");
  assert.deepEqual(killCalls, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(unhandled, []);
});

test("local cancellation waits through its final close budget and fails closed when the child persists", async () => {
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const killCalls: string[] = [];
  const runner = createDefensiveLocalCli({
    ...secureCwdDependency(),
    approvedCwds: ["/private/session"],
    killGraceMs: 1,
    closeTimeoutMs: 3,
    execFile: () => {
      markStarted?.();
      return {
        result: new Promise<{ stdout: string; stderr: string }>(() => undefined),
        closed: new Promise<void>(() => undefined),
        kill(signal: string) {
          killCalls.push(signal);
          return true;
        },
      };
    },
  } as Parameters<typeof createDefensiveLocalCli>[0]);
  const controller = new AbortController();
  const running = runner.run({ ...claudeInput(), signal: controller.signal });
  await started;
  controller.abort();

  assert.equal(await settleAsCode(running, 50), "agent_termination_unconfirmed");
  assert.deepEqual(killCalls, ["SIGTERM", "SIGKILL"]);
});

test("local CLI rejects oversized and malformed stdout without retaining child diagnostics", async () => {
  for (const [stdout, code] of [
    ["x".repeat(512 * 1024 + 1), "agent_output_byte_limit"],
    ["not-json", "agent_protocol_error"],
  ] as const) {
    const runner = createDefensiveLocalCli({
      ...secureCwdDependency(),
      approvedCwds: ["/private/session"],
      execFile: () => completedChild({ stdout, stderr: "upstream-secret-must-not-escape" }),
    });
    await assert.rejects(
      runner.run(claudeInput()),
      (error: unknown) => error instanceof DefensiveLocalCliError && error.code === code &&
        !String(error.message).includes("upstream-secret-must-not-escape"),
    );
  }
});

test("local CLI rejects an arbitrary route and never falls back from the exact catalog model", async () => {
  let calls = 0;
  const runner = createDefensiveLocalCli({
    ...secureCwdDependency(),
    approvedCwds: ["/private/session"],
    execFile: () => {
      calls += 1;
      return completedChild({ stdout: '{"findings":[]}', stderr: "" });
    },
  });

  await assert.rejects(
    runner.run({ ...claudeInput(), routeKind: "cursor-agent-local" as never }),
    { code: "protocol_unsupported" },
  );
  await assert.rejects(
    runner.run({ ...claudeInput(), model: { kind: "catalog", id: "not-in-catalog" } }),
    { code: "model_access_denied" },
  );
  await assert.rejects(
    runner.run({ ...claudeInput(), routeKind: "xai-grok-build-local", model: { kind: "runtime-default" } }),
    { code: "local_cli_isolation_unavailable" },
  );
  assert.equal(calls, 0);
});

test("Claude alone may use the explicit runtime default, which omits the model flag", async () => {
  let argv: string[] | undefined;
  const runner = createDefensiveLocalCli({
    ...secureCwdDependency(),
    approvedCwds: ["/private/session"],
    execFile: (_binary, receivedArgv) => {
      argv = receivedArgv;
      return completedChild({ stdout: '{"findings":[]}', stderr: "" });
    },
  });

  await runner.run(claudeInput());

  assert.equal(argv?.includes("--model"), false);
});

test("local CLI accepts only the caller-pinned private cwd, not a descendant path", async () => {
  let calls = 0;
  const runner = createDefensiveLocalCli({
    ...secureCwdDependency(),
    approvedCwds: ["/private/session"],
    execFile: () => {
      calls += 1;
      return completedChild({ stdout: '{"findings":[]}', stderr: "" });
    },
  });

  await assert.rejects(
    runner.run({ ...claudeInput(), cwd: "/private/session/untrusted-descendant" }),
    { code: "protocol_unsupported" },
  );
  assert.equal(calls, 0);
});

test("Claude rejects a symlink, non-directory, foreign owner, public mode, or changed realpath", async () => {
  const unsafe = [
    { symbolicLink: true },
    { directory: false },
    { uid: 777 },
    { mode: 0o40_750 },
    { realpath: "/private/other-session" },
  ];

  for (const state of unsafe) {
    let calls = 0;
    const runner = createDefensiveLocalCli({
      approvedCwds: ["/private/session"],
      approvedSnapshotRoots: ["/private/snapshot"],
      cwdInspector: testCwdInspector(state),
      execFile: () => {
        calls += 1;
        return completedChild({ stdout: '{"findings":[]}', stderr: "" });
      },
    });

    await assert.rejects(runner.run(claudeInput()), { code: "local_cli_isolation_unavailable" });
    assert.equal(calls, 0);
  }
});

test("Claude revalidates the pinned cwd inode immediately before launch", async () => {
  let lstatCalls = 0;
  let execCalls = 0;
  const runner = createDefensiveLocalCli({
    approvedCwds: ["/private/session"],
    approvedSnapshotRoots: ["/private/snapshot"],
    cwdInspector: {
      getuid: () => 501,
      async lstat(cwd: string) {
        lstatCalls += 1;
        return {
          dev: 1,
          ino: cwd === "/private/snapshot" ? 9 : lstatCalls === 1 ? 2 : 3,
          mode: cwd === "/private/snapshot" ? 0o40_500 : 0o40_700,
          uid: 501,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        };
      },
      async realpath(cwd: string) {
        return cwd;
      },
    },
    execFile: () => {
      execCalls += 1;
      return completedChild({ stdout: '{"findings":[]}', stderr: "" });
    },
  });

  await assert.rejects(runner.run(claudeInput()), { code: "local_cli_isolation_unavailable" });
  assert.equal(lstatCalls, 3);
  assert.equal(execCalls, 0);
});

test("the closed response schema enforces pattern, required, and additionalProperties", async () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: {
      id: { type: "string", pattern: "^SAFE-[0-9]+$" },
    },
  };

  for (const stdout of [
    '{"id":"unsafe"}',
    '{"id":"SAFE-1","extra":true}',
    "{}",
  ]) {
    const runner = createDefensiveLocalCli({
      ...secureCwdDependency(),
      approvedCwds: ["/private/session"],
      execFile: () => completedChild({ stdout, stderr: "" }),
    });
    await assert.rejects(
      runner.run({ ...claudeInput(), jsonSchema: schema }),
      { code: "agent_protocol_error" },
    );
  }

  const accepted = createDefensiveLocalCli({
    ...secureCwdDependency(),
    approvedCwds: ["/private/session"],
    execFile: () => completedChild({ stdout: '{"id":"SAFE-42"}', stderr: "" }),
  });
  assert.deepEqual(
    await accepted.run({ ...claudeInput(), jsonSchema: schema }),
    { final: { id: "SAFE-42" }, usage: null },
  );
});

test("the response schema subset rejects unsupported keywords before launch", async () => {
  let calls = 0;
  const runner = createDefensiveLocalCli({
    ...secureCwdDependency(),
    approvedCwds: ["/private/session"],
    execFile: () => {
      calls += 1;
      return completedChild({ stdout: "{}", stderr: "" });
    },
  });

  await assert.rejects(
    runner.run({
      ...claudeInput(),
      jsonSchema: { type: "object", unevaluatedProperties: false },
    }),
    { code: "protocol_unsupported" },
  );
  assert.equal(calls, 0);
});

test("native Node 24 maxBuffer overflow maps to agent_output_byte_limit", async (t) => {
  assert.match(process.versions.node, /^24\./);
  const { cwd, snapshotRoot } = await privateNativeRoots(t);
  let child: (DefensiveLocalCliChild & { closed: Promise<void> }) | undefined;
  const runner = createDefensiveLocalCli({
    approvedCwds: [cwd],
    approvedSnapshotRoots: [snapshotRoot],
    execFile: (_binary, _argv, options) => {
      child = nativeNodeFixture([
        "-e",
        `process.stdout.write("x".repeat(${512 * 1024 + 1}))`,
      ], options);
      return child;
    },
  });

  const outcome = await settleAsCode(
    runner.run({ ...claudeInput(), cwd, snapshotRoot }),
    1_000,
  );
  await child?.closed;

  assert.equal(outcome, "agent_output_byte_limit");
});

test("native Node 24 ABORT_ERR still escalates SIGTERM to SIGKILL until the process closes", async (t) => {
  assert.match(process.versions.node, /^24\./);
  const { cwd, snapshotRoot } = await privateNativeRoots(t);
  const readyPath = join(cwd, "ready.pid");
  const controller = new AbortController();
  const killSignals: string[] = [];
  let callbackCode: unknown;
  let fixture: (DefensiveLocalCliChild & { closed: Promise<void> }) | undefined;
  let rawChild: ReturnType<typeof nativeExecFile> | undefined;
  const runner = createDefensiveLocalCli({
    approvedCwds: [cwd],
    approvedSnapshotRoots: [snapshotRoot],
    killGraceMs: 20,
    execFile: (_binary, _argv, options) => {
      const native = nativeNodeFixture([
        "-e",
        [
          'const fs = require("node:fs")',
          'process.on("SIGTERM", () => {})',
          'fs.writeFileSync(process.argv[1], String(process.pid))',
          'setInterval(() => {}, 1_000)',
        ].join(";"),
        readyPath,
      ], options, (child) => { rawChild = child; });
      fixture = {
        ...native,
        result: native.result.catch((error: unknown) => {
          callbackCode = (error as { code?: unknown }).code;
          throw error;
        }),
        kill(signal) {
          killSignals.push(signal);
          return native.kill(signal);
        },
      };
      return fixture;
    },
  });
  t.after(async () => {
    if (rawChild?.exitCode === null && rawChild.signalCode === null) rawChild.kill("SIGKILL");
    await fixture?.closed;
  });

  const running = runner.run({ ...claudeInput(), cwd, snapshotRoot, signal: controller.signal });
  const pid = Number(await waitForFile(readyPath, 1_000));
  controller.abort();

  const outcome = await settleAsCode(running, 500);
  const closedBeforeCleanup = await settleAsBoolean(fixture!.closed, 300);
  if (!closedBeforeCleanup) rawChild?.kill("SIGKILL");
  await fixture!.closed;

  assert.equal(outcome, "agent_cancelled");
  assert.equal(callbackCode, "ABORT_ERR");
  assert.equal(closedBeforeCleanup, true);
  assert.deepEqual(killSignals, ["SIGTERM", "SIGKILL"]);
  assert.equal(rawChild?.signalCode, "SIGKILL");
  assert.equal(processExists(pid), false);
});

function claudeInput() {
  return {
    routeKind: "claude-code-local" as const,
    cwd: "/private/session",
    snapshotRoot: "/private/snapshot",
    prompt: "Inspect only.",
    model: { kind: "runtime-default" as const },
    modelCatalog: [],
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["findings"],
      properties: { findings: { type: "array" } },
    },
    maxTurns: 1,
    signal: new AbortController().signal,
  };
}

async function settleAsCode(promise: Promise<unknown>, timeoutMs: number): Promise<string> {
  return Promise.race([
    promise.then(
      () => "resolved",
      (error: unknown) => error instanceof DefensiveLocalCliError ? error.code : "rejected",
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve("test_timeout"), timeoutMs)),
  ]);
}

function secureCwdDependency() {
  return {
    approvedSnapshotRoots: ["/private/snapshot"],
    cwdInspector: {
      getuid: () => 501,
      async lstat(cwd: string) {
        return {
          dev: 1,
          ino: cwd === "/private/snapshot" ? 3 : 2,
          mode: cwd === "/private/snapshot" ? 0o40_500 : 0o40_700,
          uid: 501,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        };
      },
      async realpath(cwd: string) {
        return cwd;
      },
    },
  };
}

function testCwdInspector(state: {
  symbolicLink?: boolean;
  directory?: boolean;
  uid?: number;
  mode?: number;
  realpath?: string;
}) {
  return {
    getuid: () => 501,
    async lstat(cwd: string) {
      return {
        dev: 1,
        ino: cwd === "/private/snapshot" ? 3 : 2,
        mode: cwd === "/private/snapshot" ? 0o40_500 : state.mode ?? 0o40_700,
        uid: cwd === "/private/snapshot" ? 501 : state.uid ?? 501,
        isDirectory: () => cwd === "/private/snapshot" ? true : state.directory ?? true,
        isSymbolicLink: () => cwd === "/private/snapshot" ? false : state.symbolicLink ?? false,
      };
    },
    async realpath(cwd: string) {
      return state.realpath ?? cwd;
    },
  };
}

function completedChild(output: { stdout: string; stderr: string }) {
  return {
    result: Promise.resolve(output),
    closed: Promise.resolve(),
    kill: (_signal: "SIGTERM" | "SIGKILL") => true,
  };
}

async function privateNativeRoots(t: { after(callback: () => Promise<void>): void }): Promise<{ cwd: string; snapshotRoot: string }> {
  const created = await mkdtemp(join(tmpdir(), "csb-defensive-cli-test-"));
  const root = await realpath(created);
  const cwd = join(root, "session");
  const snapshotRoot = join(root, "snapshot");
  await mkdir(cwd, { mode: 0o700 });
  await mkdir(snapshotRoot, { mode: 0o700 });
  await chmod(snapshotRoot, 0o500);
  t.after(async () => {
    await chmod(snapshotRoot, 0o700);
    await rm(root, { recursive: true, force: true });
  });
  return { cwd, snapshotRoot };
}

function nativeNodeFixture(
  argv: string[],
  options: DefensiveLocalCliExecOptions,
  onProcess?: (child: ReturnType<typeof nativeExecFile>) => void,
): DefensiveLocalCliChild & { closed: Promise<void> } {
  let child!: ReturnType<typeof nativeExecFile>;
  let markClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => { markClosed = resolve; });
  const result = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    child = nativeExecFile(process.execPath, argv, options, (error, stdout, stderr) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
    child.once("close", () => markClosed?.());
    onProcess?.(child);
  });
  return {
    result,
    closed,
    kill: (signal) => child.kill(signal),
  };
}

async function waitForFile(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await readFile(path, "utf8");
    } catch {
      if (Date.now() >= deadline) throw new Error("native fixture did not become ready");
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
  }
}

async function settleAsBoolean(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code !== "ESRCH";
  }
}
