import assert from "node:assert/strict";
import test from "node:test";

import { createDefensiveLocalCli, DefensiveLocalCliError } from "./defensive-local-cli.js";

test("Claude local execution uses the fixed defensive argv and strips API keys", async () => {
  const calls: Array<{ binary: string; argv: string[]; options: Record<string, unknown> }> = [];
  const runner = createDefensiveLocalCli({
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
    execFile: async (binary, argv, options) => {
      calls.push({ binary, argv, options: options as unknown as Record<string, unknown> });
      return { stdout: '{"findings":[]}', stderr: "" };
    },
  });

  const result = await runner.run({
    routeKind: "claude-code-local",
    cwd: "/private/session",
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
  assert.deepEqual(calls, [{
    binary: "claude",
    argv: [
      "--print",
      "--safe-mode",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--disable-slash-commands",
      "--no-session-persistence",
      "--permission-mode",
      "plan",
      "--tools",
      "Read,Glob,Grep",
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

test("Grok local execution uses only its defensive read and grep contract", async () => {
  const calls: Array<{ binary: string; argv: string[] }> = [];
  const runner = createDefensiveLocalCli({
    approvedCwds: ["/private/session"],
    execFile: async (binary, argv) => {
      calls.push({ binary, argv });
      return { stdout: '{"findings":[]}', stderr: "" };
    },
  });

  await runner.run({
    routeKind: "xai-grok-build-local",
    cwd: "/private/session",
    prompt: "Inspect only the pinned files.",
    model: { kind: "catalog", id: "grok-4" },
    modelCatalog: ["grok-4"],
    jsonSchema: { type: "object", required: ["findings"], properties: { findings: { type: "array" } } },
    maxTurns: 2,
    signal: new AbortController().signal,
  });

  assert.deepEqual(calls, [{
    binary: "grok",
    argv: [
      "--single",
      "--permission-mode",
      "dontAsk",
      "--allow",
      "Read",
      "--allow",
      "Grep",
      "--deny",
      "Bash",
      "--deny",
      "Edit",
      "--deny",
      "WebFetch",
      "--deny",
      "WebSearch",
      "--deny",
      "MCPTool",
      "--sandbox",
      "strict",
      "--disable-web-search",
      "--no-subagents",
      "--no-memory",
      "--system-prompt-override",
      "You are a defensive, read-only security analyst. Inspect only the caller-provided pinned workspace. Do not execute commands, edit files, access network, invoke plugins, MCP tools, web, subagents, or memory. Use only Read and Grep. Return only JSON matching the supplied schema.",
      "--max-turns",
      "2",
      "--output-format",
      "json",
      "--json-schema",
      '{"type":"object","required":["findings"],"properties":{"findings":{"type":"array"}}}',
      "--model",
      "grok-4",
      "Inspect only the pinned files.",
    ],
  }]);
  const argv = calls[0]?.argv ?? [];
  for (const banned of ["--dangerously-skip-permissions", "--allow-dangerous", "--yolo", "--config"]) {
    assert.equal(argv.includes(banned), false, banned);
  }
});

test("local CLI rejects a JSON final that does not satisfy the requested schema", async () => {
  const runner = createDefensiveLocalCli({
    approvedCwds: ["/private/session"],
    execFile: async () => ({ stdout: '{"findings":"not-an-array"}', stderr: "" }),
  });

  await assert.rejects(
    runner.run({
      routeKind: "claude-code-local",
      cwd: "/private/session",
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
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const runner = createDefensiveLocalCli({
    approvedCwds: ["/private/session"],
    execFile: async (_binary, _argv, options) => {
      childSignal = options.signal;
      return new Promise<{ stdout: string; stderr: string }>((_resolve, reject) => { rejectLate = reject; });
    },
  });
  const controller = new AbortController();
  const running = runner.run({ ...claudeInput(), signal: controller.signal });
  controller.abort();

  const outcome = await settleAsCode(running, 30);
  rejectLate?.(new Error("late CLI failure must not escape"));
  await assert.rejects(running, { code: "agent_cancelled" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  process.off("unhandledRejection", onUnhandled);

  assert.equal(outcome, "agent_cancelled");
  assert.equal(childSignal?.aborted, true);
  assert.deepEqual(unhandled, []);
});

test("the local timeout settles despite an uncooperative local CLI and consumes its late rejection", async () => {
  let rejectLate: ((reason?: unknown) => void) | undefined;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const runner = createDefensiveLocalCli({
    approvedCwds: ["/private/session"],
    execFile: async () => new Promise<{ stdout: string; stderr: string }>((_resolve, reject) => { rejectLate = reject; }),
  });
  const running = runner.run({ ...claudeInput(), timeoutMs: 1 });

  const outcome = await settleAsCode(running, 30);
  rejectLate?.(new Error("late CLI failure must not escape"));
  await assert.rejects(running, { code: "agent_time_limit" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  process.off("unhandledRejection", onUnhandled);

  assert.equal(outcome, "agent_time_limit");
  assert.deepEqual(unhandled, []);
});

test("local CLI rejects oversized and malformed stdout without retaining child diagnostics", async () => {
  for (const [stdout, code] of [
    ["x".repeat(512 * 1024 + 1), "agent_output_byte_limit"],
    ["not-json", "agent_protocol_error"],
  ] as const) {
    const runner = createDefensiveLocalCli({
      approvedCwds: ["/private/session"],
      execFile: async () => ({ stdout, stderr: "upstream-secret-must-not-escape" }),
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
    approvedCwds: ["/private/session"],
    execFile: async () => {
      calls += 1;
      return { stdout: '{"findings":[]}', stderr: "" };
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
    { code: "protocol_unsupported" },
  );
  assert.equal(calls, 0);
});

test("Claude alone may use the explicit runtime default, which omits the model flag", async () => {
  let argv: string[] | undefined;
  const runner = createDefensiveLocalCli({
    approvedCwds: ["/private/session"],
    execFile: async (_binary, receivedArgv) => {
      argv = receivedArgv;
      return { stdout: '{"findings":[]}', stderr: "" };
    },
  });

  await runner.run(claudeInput());

  assert.equal(argv?.includes("--model"), false);
});

test("local CLI accepts only the caller-pinned private cwd, not a descendant path", async () => {
  let calls = 0;
  const runner = createDefensiveLocalCli({
    approvedCwds: ["/private/session"],
    execFile: async () => {
      calls += 1;
      return { stdout: '{"findings":[]}', stderr: "" };
    },
  });

  await assert.rejects(
    runner.run({ ...claudeInput(), cwd: "/private/session/untrusted-descendant" }),
    { code: "protocol_unsupported" },
  );
  assert.equal(calls, 0);
});

function claudeInput() {
  return {
    routeKind: "claude-code-local" as const,
    cwd: "/private/session",
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
