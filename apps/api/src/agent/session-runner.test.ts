import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { ModelCapabilities, ProviderModel } from "@csb/shared";
import { createAgentSession, DEFAULT_AGENT_LIMITS } from "./session-runner.js";
import { probeOpenAiChatSession } from "./openai-chat-session.js";
import {
  AgentSessionError,
  createConstrainedWireSession,
  type AgentSessionTimer,
  type AgentToolCall,
  type AgentToolResult,
  type AgentUpstreamRequest,
  type NormalizedModelReply,
  type WireSessionAdapter,
} from "./session-types.js";
import { createPortableCodexSecurityReportShards } from "../scanners/portable-codex-security-report-shards.js";

test("a session cannot be created from an unmeasured tool capability", async () => {
  await assert.rejects(createAgentSession({
    probe: { ...capability(), tools: "unsupported" },
    protocol: "openai-chat",
  } as never), { code: "runner_capability_missing" });
});

test("an endless valid tool transcript stops before an N+1 model or tool call", async (t) => {
  const root = await mkdtemp(join(process.cwd(), ".test-agent-runner-"));
  const snapshotRoot = join(root, "snapshot");
  const artifactRoot = join(root, "artifacts");
  await mkdir(snapshotRoot);
  await mkdir(artifactRoot, { mode: 0o700 });
  await writeFile(join(snapshotRoot, "index.ts"), "export const value = 1;\n");
  t.after(async () => rm(root, { recursive: true, force: true }));

  const upstream = alwaysRequestsWorkspaceRead();
  const session = await createAgentSession({
    probe: capability(),
    protocol: "openai-chat",
    routeKind: "gemini-api",
    connectionId: "connection-a",
    model: model("account-visible"),
    snapshotRoot,
    artifactRoot,
    instructions: "Inspect the snapshot and report only through the allowed tools.",
    limits: { ...DEFAULT_AGENT_LIMITS, maxModelTurns: 3, maxToolCalls: 2 },
    signal: new AbortController().signal,
  }, upstream);

  const events: unknown[] = [];
  await assert.rejects(collect(session.run(), events), { code: "agent_tool_limit" });
  assert.equal(upstream.modelCalls, 2);
  assert.equal(events.filter(isCompletedTool).length, 2);
});

test("the shared session reserves its final turns for artifact write and completion", async () => {
  const requestedTools: string[] = [];
  const controls: Array<{ finalizationRequired?: boolean } | undefined> = [];
  let reply: NormalizedModelReply = {
    toolCalls: [],
    text: null,
    structured: null,
    usage: null,
  };
  const adapter = {
    nextRequest(
      toolResults: readonly AgentToolResult[],
      control?: { finalizationRequired?: boolean },
    ) {
      controls.push(control);
      if (toolResults.some((result) => result.name === "results.write" && result.ok !== false)) {
        reply = {
          toolCalls: [],
          text: '{"status":"completed"}',
          structured: { status: "completed" },
          usage: null,
        };
      } else if (control?.finalizationRequired === true) {
        reply = {
          toolCalls: [{
            id: "write-final",
            name: "results.write",
            input: { path: "result.json", content: "{}" },
          }],
          text: null,
          structured: null,
          usage: null,
        };
      } else {
        reply = {
          toolCalls: [{
            id: `search-${controls.length}`,
            name: "workspace.search",
            input: { query: `candidate-${controls.length}` },
          }],
          text: null,
          structured: null,
          usage: null,
        };
      }
      return { operation: "messages" as const, body: {} };
    },
    readResponse() {
      return reply;
    },
  } as WireSessionAdapter;
  const session = createConstrainedWireSession({
    limits: {
      maxModelTurns: 6,
      maxToolCalls: 12,
      maxInputBytes: 1_048_576,
      maxOutputBytes: 1_048_576,
      timeoutMs: 60_000,
    },
    signal: new AbortController().signal,
    host: {
      minimumOutputBytes() { return 0; },
      async call(name) {
        requestedTools.push(name);
        return name === "results.write"
          ? { content: "artifact-written", artifact: { path: "result.json", bytes: 2 } }
          : { content: "[]" };
      },
    },
    upstream: { async request() { return {}; } },
    adapter,
  });

  const events: unknown[] = [];
  await collect(session.run(), events);

  assert.equal(controls.some((control) => control?.finalizationRequired === true), true);
  assert.equal(requestedTools.at(-1), "results.write");
  assert.equal(requestedTools.filter((name) => name === "results.write").length, 1);
  assert.equal(events.some((event) =>
    typeof event === "object" && event !== null &&
    (event as { type?: unknown }).type === "completion"), true);
});

for (const [maxModelTurns, ignoredFinalizationRequests] of [[32, 3], [64, 7]] as const) {
test(`artifact-write sessions reserve enough of ${maxModelTurns} turns for a reasoning model to obey finalization`, async () => {
  let finalizationRequests = 0;
  let explorationRequests = 0;
  let reply: NormalizedModelReply = {
    toolCalls: [], text: null, structured: null, usage: null,
  };
  const adapter = {
    nextRequest(
      _toolResults: readonly AgentToolResult[],
      control?: { finalizationRequired?: boolean },
    ) {
      if (control?.finalizationRequired === true) {
        finalizationRequests += 1;
        reply = finalizationRequests <= ignoredFinalizationRequests
          ? {
            toolCalls: [{
              id: `ignored-read-${finalizationRequests}`,
              name: "workspace.read",
              input: { path: "index.ts" },
            }],
            text: null,
            structured: null,
            usage: null,
          }
          : {
            toolCalls: [{
              id: "write-after-reminders",
              name: "results.write",
              input: { path: "result.json", content: "{}" },
            }],
            text: null,
            structured: null,
            usage: null,
          };
      } else {
        explorationRequests += 1;
        reply = {
          toolCalls: [{
            id: `explore-${explorationRequests}`,
            name: "workspace.read",
            input: { path: "index.ts" },
          }],
          text: null,
          structured: null,
          usage: null,
        };
      }
      return { operation: "messages" as const, body: {} };
    },
    readResponse() { return reply; },
  } as WireSessionAdapter;
  const hostCalls: string[] = [];
  const session = createConstrainedWireSession({
    terminalMode: "artifact-write",
    limits: {
      maxModelTurns,
      maxToolCalls: 128,
      maxInputBytes: 1_048_576,
      maxOutputBytes: 1_048_576,
      timeoutMs: 60_000,
    },
    signal: new AbortController().signal,
    host: {
      minimumOutputBytes() { return 0; },
      async call(name) {
        hostCalls.push(name);
        return name === "results.write"
          ? { content: "written", artifact: { path: "result.json", bytes: 2 } }
          : { content: "source" };
      },
    },
    upstream: { async request() { return {}; } },
    adapter,
  });

  await collect(session.run(), []);

  assert.equal(finalizationRequests, ignoredFinalizationRequests + 1);
  assert.equal(explorationRequests + finalizationRequests, maxModelTurns);
  assert.equal(hostCalls.at(-1), "results.write");
  assert.equal(hostCalls.includes("workspace.read"), true);
});
}

test("artifact-write deadline forces results.write before the global turn reserve", async () => {
  const controls: Array<{ finalizationRequired?: boolean } | undefined> = [];
  let reply: NormalizedModelReply = { toolCalls: [], text: null, structured: null, usage: null };
  let request = 0;
  const session = createConstrainedWireSession({
    terminalMode: "artifact-write",
    artifactWriteByTurn: 4,
    limits: {
      maxModelTurns: 16,
      maxToolCalls: 64,
      maxInputBytes: 1_048_576,
      maxOutputBytes: 1_048_576,
      timeoutMs: 60_000,
    },
    signal: new AbortController().signal,
    host: {
      minimumOutputBytes() { return 0; },
      async call(name) {
        return name === "results.write"
          ? { content: "ok", artifact: { path: "result.json", bytes: 2 } }
          : { content: "inspected" };
      },
    },
    adapter: {
      nextRequest(_results, control) {
        controls.push(control);
        request += 1;
        reply = control?.finalizationRequired === true
          ? { toolCalls: [{ id: "write", name: "results.write", input: { path: "result.json", content: "{}" } }], text: null, structured: null, usage: null }
          : { toolCalls: [{ id: `read-${request}`, name: "workspace.read", input: { path: "index.ts" } }], text: null, structured: null, usage: null };
        return { operation: "messages" as const, body: {} };
      },
      readResponse() { return reply; },
    } as WireSessionAdapter,
    upstream: { async request() { return {}; } },
  });

  const events: unknown[] = [];
  await collect(session.run(), events);
  assert.equal(controls.slice(0, 4).every((control) => control === undefined), true);
  assert.equal(controls[4]?.finalizationRequired, true);
  assert.equal(events.some((event) =>
    typeof event === "object" && event !== null &&
    (event as { type?: unknown }).type === "artifact"), true);
});

test("a Gemini OpenAI chat probe proves agent facts only after the complete artifact loop", async (t) => {
  const fixture = await fixtureRoots("probe-complete");
  t.after(fixture.cleanup);
  const selected = model("account-visible");
  const upstream = fakeOpenAiChat([
    chatToolCall("workspace.read", { path: "index.ts" }, "read-1"),
    chatToolCall("results.write", { path: "probe-result.json", content: JSON.stringify({ status: "ok" }) }, "write-1"),
    chatFinalStructured({ status: "ok" }),
  ]);

  const report = await probeOpenAiChatSession({
    connectionId: "connection-a",
    routeKind: "gemini-api",
  }, selected, probeSpec(fixture), upstream);

  assert.equal(wireOperation(upstream.requests[0]), "chat-completions");
  assert.equal(upstream.requests[0] !== undefined && "url" in upstream.requests[0], false);
  assert.equal(upstream.modelIds.every((id) => id === selected.id), true);
  assert.deepEqual(pickAgentFacts(report), {
    tools: "supported",
    artifactOutput: "supported",
    structuredOutput: "supported",
    boundedExecution: "supported",
  });
});

test("an incomplete Gemini transcript keeps agent facts unknown while proving bounded execution", async (t) => {
  const fixture = await fixtureRoots("probe-incomplete");
  t.after(fixture.cleanup);
  const report = await probeOpenAiChatSession({
    connectionId: "connection-a",
    routeKind: "gemini-api",
  }, model("account-visible"), probeSpec(fixture), fakeOpenAiChat([chatFinalText("no tools")]));

  assert.deepEqual(pickAgentFacts(report), {
    tools: "unknown",
    artifactOutput: "unknown",
    structuredOutput: "unknown",
    boundedExecution: "supported",
  });
});

test("plain chat completion never enters the tool loop", async (t) => {
  const fixture = await fixtureRoots("plain-chat");
  t.after(fixture.cleanup);
  const upstream = fakeOpenAiChat([chatFinalText("plain completion")]);
  const session = await createAgentSession({
    ...sessionSpec(fixture, "openai-chat", "gemini-api"),
    probe: capability(),
  }, upstream);

  const events: unknown[] = [];
  await collect(session.run(), events);
  assert.equal(upstream.requests.length, 1);
  assert.equal(events.some((event) => isCompletedTool(event)), false);
});

test("session runner forwards only a published effort over a proven route codec", async (t) => {
  const fixture = await fixtureRoots("published-reasoning-effort");
  t.after(fixture.cleanup);
  const selected = {
    ...model("account-visible"),
    reasoningEffort: { options: ["low", "high"], default: "high" },
  };
  const upstream = fakeOpenAiChat([chatFinalText("completed")]);
  const session = await createAgentSession({
    ...sessionSpec(fixture, "openai-chat", "gemini-api"),
    model: selected,
    reasoningEffort: "high",
    probe: capability(),
  }, upstream);

  await collect(session.run(), []);
  assert.equal((upstream.requests[0]?.body as { reasoning_effort?: unknown }).reasoning_effort, "high");
  await assert.rejects(createAgentSession({
    ...sessionSpec(fixture, "openai-chat", "gemini-api"),
    model: selected,
    reasoningEffort: "ultra",
    probe: capability(),
  }, fakeOpenAiChat([])), { code: "runner_invalid_spec" });

  for (const routeKind of ["deepseek-api", "custom-openai-compatible"]) {
    await assert.rejects(createAgentSession({
      ...sessionSpec(fixture, "openai-chat", routeKind),
      model: selected,
      reasoningEffort: "high",
      probe: capability(),
    }, fakeOpenAiChat([])), { code: "runner_invalid_spec" }, routeKind);
  }
});

test("duplicate tool ids and malformed function arguments fail without a follow-on tool", async (t) => {
  const duplicateFixture = await fixtureRoots("duplicate-tool");
  const malformedFixture = await fixtureRoots("malformed-tool");
  t.after(duplicateFixture.cleanup);
  t.after(malformedFixture.cleanup);

  const duplicate = fakeOpenAiChat([
    chatToolCall("workspace.read", { path: "index.ts" }, "same-id"),
    chatToolCall("workspace.read", { path: "index.ts" }, "same-id"),
  ]);
  const duplicateSession = await createAgentSession({
    ...sessionSpec(duplicateFixture, "openai-chat", "gemini-api"),
    probe: capability(),
  }, duplicate);
  await assert.rejects(collect(duplicateSession.run(), []), { code: "agent_protocol_error" });
  assert.equal(duplicate.requests.length, 2);

  const malformed = fakeOpenAiChat([{
    choices: [{
      message: {
        tool_calls: [{
          id: "invalid-args",
          type: "function",
          function: { name: "workspace_read", arguments: "{" },
        }],
      },
    }],
  }]);
  const malformedSession = await createAgentSession({
    ...sessionSpec(malformedFixture, "openai-chat", "gemini-api"),
    probe: capability(),
  }, malformed);
  await assert.rejects(collect(malformedSession.run(), []), { code: "agent_protocol_error" });
  assert.equal(malformed.requests.length, 1);
});

test("the runner stops output overflow before a tool can be invoked", async (t) => {
  const fixture = await fixtureRoots("output-overflow");
  t.after(fixture.cleanup);
  const upstream = fakeOpenAiChat([chatFinalText("this response is intentionally longer than one byte")]);
  const session = await createAgentSession({
    ...sessionSpec(fixture, "openai-chat", "gemini-api", { maxOutputBytes: 1 }),
    probe: capability(),
  }, upstream);

  await assert.rejects(collect(session.run(), []), { code: "agent_output_byte_limit" });
  assert.equal(upstream.requests.length, 1);
});

test("input and turn budgets stop before their next upstream request", async (t) => {
  const inputFixture = await fixtureRoots("input-overflow");
  const turnsFixture = await fixtureRoots("turn-limit");
  t.after(inputFixture.cleanup);
  t.after(turnsFixture.cleanup);

  const inputUpstream = fakeOpenAiChat([chatFinalText("must not be requested")]);
  const inputSession = await createAgentSession({
    ...sessionSpec(inputFixture, "openai-chat", "gemini-api", { maxInputBytes: 1 }),
    probe: capability(),
  }, inputUpstream);
  await assert.rejects(collect(inputSession.run(), []), { code: "agent_input_byte_limit" });
  assert.equal(inputUpstream.requests.length, 0);

  const turnUpstream = alwaysRequestsWorkspaceRead();
  const turnSession = await createAgentSession({
    ...sessionSpec(turnsFixture, "openai-chat", "gemini-api", { maxModelTurns: 1, maxToolCalls: 2 }),
    probe: capability(),
  }, turnUpstream);
  await assert.rejects(collect(turnSession.run(), []), { code: "agent_turn_limit" });
  assert.equal(turnUpstream.modelCalls, 1);
});

test("deadline and abort cancel in-flight work without issuing another model request", async (t) => {
  const abortFixture = await fixtureRoots("abort-limit");
  t.after(abortFixture.cleanup);

  let timeCalls = 0;
  const timeStarted = deferred<void>();
  const timeTimer = manualTimer();
  const timeUpstream = {
    async request(request: { signal: AbortSignal }) {
      timeCalls += 1;
      timeStarted.resolve();
      await new Promise<void>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return chatFinalText("unreachable");
    },
    async cancel() {
      return true;
    },
  };
  const timeSession = createConstrainedWireSession({
    limits: { ...DEFAULT_AGENT_LIMITS, timeoutMs: 1 },
    signal: new AbortController().signal,
    host: noToolHost(),
    upstream: timeUpstream,
    adapter: finalOnlyAdapter(),
    now: () => 0,
    timer: timeTimer,
  });
  const timeEvents: unknown[] = [];
  const timeRunning = collect(timeSession.run(), timeEvents);
  await timeStarted.promise;
  timeTimer.fireNext();
  await assert.rejects(timeRunning, { code: "agent_time_limit" });
  assert.equal(timeCalls, 1);
  assert.equal(timeEvents.some((event) => isCancellation(event, true)), true);

  const controller = new AbortController();
  const abortUpstream = fakeOpenAiChat([
    chatToolCall("workspace.read", { path: "index.ts" }, "read-once"),
    chatFinalText("this completion must be discarded"),
  ]);
  const originalRequest = abortUpstream.request;
  abortUpstream.request = async (request) => {
    const response = await originalRequest(request);
    if (abortUpstream.requests.length === 2) controller.abort();
    return response;
  };
  const abortSession = await createAgentSession({
    ...sessionSpec(abortFixture, "openai-chat", "gemini-api"),
    signal: controller.signal,
    probe: capability(),
  }, {
    ...abortUpstream,
    async cancel() {
      return true;
    },
  });
  const abortEvents: unknown[] = [];
  await collect(abortSession.run(), abortEvents);
  assert.equal(abortUpstream.requests.length, 2);
  assert.equal(abortEvents.some((event) => isCancellation(event, true)), true);
});

test("deadline cuts off an upstream request that ignores AbortSignal and handles a late rejection", async (t) => {
  const fixture = await fixtureRoots("ignored-deadline-signal");
  t.after(fixture.cleanup);
  const started = deferred<void>();
  let rejectLate: ((error: Error) => void) | undefined;
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));

  const session = await createAgentSession({
    ...sessionSpec(fixture, "openai-chat", "gemini-api", { timeoutMs: 5 }),
    probe: capability(),
  }, {
    request() {
      started.resolve();
      return new Promise((_resolve, reject) => {
        rejectLate = reject;
      });
    },
    async cancel() {
      return true;
    },
  });
  const events: unknown[] = [];
  const running = collect(session.run(), events);
  await started.promise;
  await assert.rejects(withTestDeadline(running, 250), { code: "agent_time_limit" });
  assert.equal(events.some((event) => isCancellation(event, true)), true);

  rejectLate?.(new Error("late upstream rejection"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
});

test("cancel cuts off an upstream request that ignores AbortSignal", async (t) => {
  const fixture = await fixtureRoots("ignored-cancel-signal");
  t.after(fixture.cleanup);
  const started = deferred<void>();
  let rejectLate: ((error: Error) => void) | undefined;
  const session = await createAgentSession({
    ...sessionSpec(fixture, "openai-chat", "gemini-api"),
    probe: capability(),
  }, {
    request() {
      started.resolve();
      return new Promise((_resolve, reject) => {
        rejectLate = reject;
      });
    },
    async cancel() {
      return true;
    },
  });
  const events: unknown[] = [];
  const running = collect(session.run(), events);
  t.after(async () => {
    rejectLate?.(new Error("test cleanup"));
    await running.catch(() => undefined);
  });
  await started.promise;
  assert.deepEqual(await session.cancel(), { remote: true });
  await withTestDeadline(running, 250);
  assert.equal(events.some((event) => isCancellation(event, true)), true);
});

test("a hanging remote cancellation cannot block local session finalization", async (t) => {
  const started = deferred<void>();
  const timer = manualTimer();
  let rejectRemote: ((reason?: unknown) => void) | undefined;
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const session = createConstrainedWireSession({
    limits: { ...DEFAULT_AGENT_LIMITS, timeoutMs: 10_000 },
    signal: new AbortController().signal,
    host: noToolHost(),
    adapter: finalOnlyAdapter(),
    now: () => 0,
    timer,
    upstream: {
      request() {
        started.resolve();
        return new Promise(() => undefined);
      },
      cancel() {
        return new Promise((_resolve, reject) => {
          rejectRemote = reject;
        });
      },
    },
  });
  const events: unknown[] = [];
  const running = collect(session.run(), events);
  void running.catch(() => undefined);

  await started.promise;
  const cancellation = session.cancel();
  timer.fireNext();
  assert.deepEqual(await cancellation, { remote: false });
  await running;
  assert.equal(events.some((event) => isCancellation(event, false)), true);
  assert.notEqual(rejectRemote, undefined);
  rejectRemote?.(new Error("late remote cancellation rejection"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
});

test("the constrained session executes a read before a terminal results.write in one reply", async () => {
  const toolCalls: Array<{ name: string; input: unknown }> = [];
  const requestedWith: AgentToolResult[][] = [];
  const replies: NormalizedModelReply[] = [
    {
      toolCalls: [
        { id: "read-1", name: "workspace.read", input: { path: "index.ts" } },
        { id: "write-1", name: "results.write", input: { path: "report.json", content: "{}" } },
      ],
      text: null,
      structured: null,
      usage: null,
    },
    { toolCalls: [], text: "complete", structured: null, usage: null },
  ];
  const adapter = transcriptAdapter(replies, requestedWith);
  const session = createConstrainedWireSession({
    limits: DEFAULT_AGENT_LIMITS,
    signal: new AbortController().signal,
    host: {
      minimumOutputBytes() {
        return 0;
      },
      async call(name, input) {
        toolCalls.push({ name, input });
        return { content: `${name}-result` };
      },
    },
    upstream: { async request() { return {}; } },
    adapter,
  });

  await collect(session.run(), []);

  assert.deepEqual(toolCalls, [
    { name: "workspace.read", input: { path: "index.ts" } },
    { name: "results.write", input: { path: "report.json", content: "{}" } },
  ]);
  assert.deepEqual(requestedWith, [
    [],
    [
      { callId: "read-1", name: "workspace.read", content: "workspace.read-result" },
      { callId: "write-1", name: "results.write", content: "results.write-result" },
    ],
  ]);
});

test("a terminal results.write batch may use the last tool slot before completion", async () => {
  const requestedWith: AgentToolResult[][] = [];
  const replies: NormalizedModelReply[] = [
    {
      toolCalls: [
        { id: "read-last", name: "workspace.read", input: { path: "index.ts" } },
        { id: "write-last", name: "results.write", input: { path: "report.json", content: "{}" } },
      ],
      text: null,
      structured: null,
      usage: null,
    },
    { toolCalls: [], text: "complete", structured: { status: "complete" }, usage: null },
  ];
  const session = createConstrainedWireSession({
    limits: {
      ...DEFAULT_AGENT_LIMITS,
      maxModelTurns: 3,
      maxToolCalls: 2,
    },
    signal: new AbortController().signal,
    host: {
      minimumOutputBytes() { return 0; },
      async call(name) {
        return name === "results.write"
          ? { content: "artifact-written", artifact: { path: "report.json", bytes: 2 } }
          : { content: "safe read" };
      },
    },
    upstream: { async request() { return {}; } },
    adapter: transcriptAdapter(replies, requestedWith),
  });

  const events: unknown[] = [];
  await collect(session.run(), events);

  assert.equal(requestedWith.length, 2);
  assert.equal(events.some((event) =>
    typeof event === "object" && event !== null &&
    (event as { type?: unknown }).type === "completion"), true);
});

test("an artifact-terminal session ends after the accepted artifact without another provider request", async () => {
  const requestedWith: AgentToolResult[][] = [];
  let providerRequests = 0;
  const replies: NormalizedModelReply[] = [
    {
      toolCalls: [{ id: "read-terminal", name: "workspace.read", input: { path: "index.ts" } }],
      text: null,
      structured: null,
      usage: null,
    },
    {
      toolCalls: [{
        id: "write-terminal",
        name: "results.write",
        input: { path: "report.json", content: "{}" },
      }],
      text: null,
      structured: null,
      usage: null,
    },
  ];
  const session = createConstrainedWireSession({
    limits: DEFAULT_AGENT_LIMITS,
    signal: new AbortController().signal,
    terminalMode: "artifact-write",
    host: {
      minimumOutputBytes() { return 0; },
      async call(name) {
        return name === "results.write"
          ? { content: "artifact-written", artifact: { path: "report.json", bytes: 2 } }
          : { content: "safe read" };
      },
    },
    upstream: {
      async request() {
        providerRequests += 1;
        return {};
      },
    },
    adapter: transcriptAdapter(replies, requestedWith),
  });

  const events: unknown[] = [];
  await collect(session.run(), events);

  assert.equal(providerRequests, 2);
  assert.equal(requestedWith.length, 2);
  assert.equal(events.some((event) =>
    typeof event === "object" && event !== null &&
    (event as { type?: unknown }).type === "tool" &&
    (event as { phase?: unknown }).phase === "consumed" &&
    (event as { name?: unknown }).name === "workspace.read"), true);
  assert.equal(events.some((event) => isArtifact(event, "report.json")), true);
  assert.equal(events.some((event) =>
    typeof event === "object" && event !== null &&
    (event as { type?: unknown }).type === "completion"), false);
});

test("an artifact-terminal session rejects an unconsumed read and write batch before host I/O", async () => {
  let hostCalls = 0;
  const session = createConstrainedWireSession({
    limits: DEFAULT_AGENT_LIMITS,
    signal: new AbortController().signal,
    terminalMode: "artifact-write",
    host: {
      minimumOutputBytes() { return 0; },
      async call() {
        hostCalls += 1;
        return { content: "unexpected" };
      },
    },
    upstream: { async request() { return {}; } },
    adapter: transcriptAdapter([{
      toolCalls: [
        { id: "read-unconsumed", name: "workspace.read", input: { path: "index.ts" } },
        { id: "write-unconsumed", name: "results.write", input: { path: "report.json", content: "{}" } },
      ],
      text: null,
      structured: null,
      usage: null,
    }], []),
  });

  await assert.rejects(collect(session.run(), []), (error: unknown) =>
    error instanceof AgentSessionError && error.code === "agent_protocol_error");
  assert.equal(hostCalls, 0);
});

test("the constrained session returns a safe workspace path error so the model can correct it", async () => {
  const requestedWith: AgentToolResult[][] = [];
  const replies: NormalizedModelReply[] = [
    {
      toolCalls: [{ id: "read-invalid", name: "workspace.read", input: { path: "/private/secret.ts" } }],
      text: null,
      structured: null,
      usage: null,
    },
    {
      toolCalls: [{ id: "read-valid", name: "workspace.read", input: { path: "index.ts" } }],
      text: null,
      structured: null,
      usage: null,
    },
    { toolCalls: [], text: "complete", structured: null, usage: null },
  ];
  let hostCalls = 0;
  const session = createConstrainedWireSession({
    limits: DEFAULT_AGENT_LIMITS,
    signal: new AbortController().signal,
    host: {
      minimumOutputBytes() {
        return 0;
      },
      async call() {
        hostCalls += 1;
        if (hostCalls === 1) throw new AgentSessionError("tool_path_denied");
        return { content: "safe read" };
      },
    },
    upstream: { async request() { return {}; } },
    adapter: transcriptAdapter(replies, requestedWith),
  });

  await collect(session.run(), []);
  assert.equal(hostCalls, 2);
  assert.match(requestedWith[1]![0]!.content, /tool_path_denied/);
  assert.equal(requestedWith[1]![0]!.content.includes("/private/secret.ts"), false);
  assert.equal(requestedWith[2]![0]!.content, "safe read");
});

test("the constrained session corrects a malformed terminal report before any artifact I/O", async () => {
  const requestedWith: AgentToolResult[][] = [];
  const validReport = {
    schemaVersion: 1,
    findings: [],
  };
  const replies: NormalizedModelReply[] = [
    {
      toolCalls: [{
        id: "write-invalid",
        name: "results.write",
        input: { path: "sentinel-findings.json", content: "{malformed" },
      }],
      text: null,
      structured: null,
      usage: null,
    },
    {
      toolCalls: [{
        id: "write-valid",
        name: "results.write",
        input: { path: "sentinel-findings.json", content: JSON.stringify(validReport) },
      }],
      text: null,
      structured: null,
      usage: null,
    },
    { toolCalls: [], text: "complete", structured: { status: "complete" }, usage: null },
  ];
  const hostInputs: unknown[] = [];
  const session = createConstrainedWireSession({
    limits: DEFAULT_AGENT_LIMITS,
    signal: new AbortController().signal,
    resultArtifactContract: "vulnhunter-report-v1",
    host: {
      minimumOutputBytes() {
        return 0;
      },
      async call(_name, input) {
        hostInputs.push(input);
        return { content: "artifact-written" };
      },
    },
    upstream: { async request() { return {}; } },
    adapter: transcriptAdapter(replies, requestedWith),
  });

  await collect(session.run(), []);

  assert.equal(hostInputs.length, 1);
  assert.deepEqual(hostInputs[0], {
    path: "sentinel-findings.json",
    content: JSON.stringify(validReport),
  });
  assert.equal(requestedWith[1]![0]!.ok, false);
  assert.match(requestedWith[1]![0]!.content, /tool_argument_invalid/);
  assert.equal(requestedWith[1]![0]!.content.includes("{malformed"), false);
  assert.equal(requestedWith[2]![0]!.ok, undefined);
});

test("a Mantis report repairs an invalid locator before the sole artifact write", async (t) => {
  const root = await mkdtemp(join(process.cwd(), ".test-mantis-report-"));
  const snapshotRoot = join(root, "snapshot");
  await mkdir(join(snapshotRoot, "routes"), { recursive: true });
  await writeFile(join(snapshotRoot, "routes", "redirect.ts"), "one\ntwo\n");
  t.after(async () => rm(root, { recursive: true, force: true }));
  const requestedWith: AgentToolResult[][] = [];
  const base = {
    schemaVersion: 1,
    engine: "mantis",
    stage: "report",
    findings: [{
      id: "MANTIS-1",
      title: "Unvalidated redirect can cross the trust boundary",
      severity: "high",
      remediation: "Validate destinations against a strict server-owned allowlist.",
      code_paths: ["routes/redirect.ts"],
    }],
  };
  const corrected = structuredClone(base);
  corrected.findings[0]!.code_paths = ["routes/redirect.ts:1-2"];
  const hostInputs: unknown[] = [];
  const session = createConstrainedWireSession({
    limits: DEFAULT_AGENT_LIMITS,
    signal: new AbortController().signal,
    terminalMode: "artifact-write",
    resultArtifactContract: "mantis-report-v1",
    resultArtifactSnapshotRoot: snapshotRoot,
    host: {
      minimumOutputBytes() { return 0; },
      async call(_name, input) {
        hostInputs.push(input);
        return { content: "artifact-written", artifact: { path: "report.json", bytes: 1 } };
      },
    },
    upstream: { async request() { return {}; } },
    adapter: transcriptAdapter([
      { toolCalls: [{ id: "bad", name: "results.write", input: { path: "report.json", content: JSON.stringify(base) } }], text: null, structured: null, usage: null },
      { toolCalls: [{ id: "good", name: "results.write", input: { path: "report.json", content: JSON.stringify(corrected) } }], text: null, structured: null, usage: null },
    ], requestedWith),
  });

  await collect(session.run(), []);
  assert.equal(hostInputs.length, 1);
  assert.deepEqual(hostInputs[0], { path: "report.json", content: JSON.stringify(corrected) });
  assert.match(requestedWith[1]![0]!.content, /mantis-report-invalid/);
  assert.match(requestedWith[1]![0]!.content, /"findingIndex":0/);
  assert.equal(requestedWith[1]![0]!.content.includes("routes\/redirect"), false);
});

test("an artifact-terminal session retries malformed JSON before creating an artifact", async () => {
  const requestedWith: AgentToolResult[][] = [];
  const replies: NormalizedModelReply[] = [
    {
      toolCalls: [{
        id: "write-truncated",
        name: "results.write",
        input: {
          path: "01-inventory.json",
          content: '{"schemaVersion":1,"stage":"inventory","summary":"truncated',
        },
      }],
      text: null,
      structured: null,
      usage: null,
    },
    {
      toolCalls: [{
        id: "write-complete",
        name: "results.write",
        input: {
          path: "01-inventory.json",
          content: JSON.stringify({
            schemaVersion: 1,
            stage: "inventory",
            summary: "complete",
            observations: [],
          }),
        },
      }],
      text: null,
      structured: null,
      usage: null,
    },
  ];
  const hostInputs: unknown[] = [];
  const session = createConstrainedWireSession({
    limits: DEFAULT_AGENT_LIMITS,
    signal: new AbortController().signal,
    terminalMode: "artifact-write",
    host: {
      minimumOutputBytes() {
        return 0;
      },
      async call(_name, input) {
        hostInputs.push(input);
        return {
          content: "artifact-written",
          artifact: { path: "01-inventory.json", bytes: 96 },
        };
      },
    },
    upstream: { async request() { return {}; } },
    adapter: transcriptAdapter(replies, requestedWith),
  });

  const events: unknown[] = [];
  await collect(session.run(), events);

  assert.equal(hostInputs.length, 1);
  assert.deepEqual(hostInputs[0], {
    path: "01-inventory.json",
    content: JSON.stringify({
      schemaVersion: 1,
      stage: "inventory",
      summary: "complete",
      observations: [],
    }),
  });
  assert.equal(requestedWith[1]![0]!.ok, false);
  assert.match(requestedWith[1]![0]!.content, /tool_argument_invalid/);
  assert.equal(requestedWith[1]![0]!.content.includes("truncated"), false);
  assert.equal(events.filter((event) => isArtifact(event, "01-inventory.json")).length, 1);
});

test("an artifact-terminal session corrects a Portable discovery anchor before artifact I/O", async (t) => {
  const fixture = await fixtureRoots("runner-portable-anchor");
  t.after(fixture.cleanup);
  const requestedWith: AgentToolResult[][] = [];
  const discovery = (endLine: number) => ({
    schemaVersion: 1,
    stage: "discovery",
    summary: "Discovery recorded a repository-backed candidate.",
    observations: [],
    candidates: [{
      id: "candidate-index",
      category: "authorization",
      anchors: [{ path: "index.ts", startLine: 1, endLine, role: "source" }],
    }],
  });
  const replies: NormalizedModelReply[] = [
    {
      toolCalls: [{
        id: "write-invalid-anchor",
        name: "results.write",
        input: { path: "03-discovery.json", content: JSON.stringify(discovery(2)) },
      }],
      text: null,
      structured: null,
      usage: null,
    },
    {
      toolCalls: [{
        id: "write-valid-anchor",
        name: "results.write",
        input: { path: "03-discovery.json", content: JSON.stringify(discovery(1)) },
      }],
      text: null,
      structured: null,
      usage: null,
    },
  ];
  const hostInputs: unknown[] = [];
  const session = createConstrainedWireSession({
    limits: DEFAULT_AGENT_LIMITS,
    signal: new AbortController().signal,
    terminalMode: "artifact-write",
    resultArtifactContract: "portable-stage-json-v1",
    resultArtifactSnapshotRoot: fixture.snapshotRoot,
    resultArtifactValidationContext: {
      dossier: {
        schemaVersion: 1,
        stageSummaries: [],
        candidates: [],
        assessments: [],
        scope: { inspected: [], unexamined: [] },
      },
    },
    host: {
      minimumOutputBytes() { return 0; },
      async call(_name, input) {
        hostInputs.push(input);
        return {
          content: "artifact-written",
          artifact: { path: "03-discovery.json", bytes: 128 },
        };
      },
    },
    upstream: { async request() { return {}; } },
    adapter: transcriptAdapter(replies, requestedWith),
  });

  const events: unknown[] = [];
  await collect(session.run(), events);

  assert.deepEqual(hostInputs, [{
    path: "03-discovery.json",
    content: JSON.stringify(discovery(1)),
  }]);
  assert.equal(requestedWith[1]![0]!.ok, false);
  assert.match(requestedWith[1]![0]!.content, /tool_argument_invalid/);
  assert.match(requestedWith[1]![0]!.content, /stage-anchor-invalid/);
  assert.match(requestedWith[1]![0]!.content, /"path":"index.ts"/);
  assert.match(requestedWith[1]![0]!.content, /"violations":\[/);
  assert.match(requestedWith[1]![0]!.content, /"maxLine":1/);
  assert.match(requestedWith[1]![0]!.content, /schemaVersion 1/);
  assert.match(requestedWith[1]![0]!.content, /scope paths as '\.'/);
  assert.equal(events.some((event) =>
    typeof event === "object" && event !== null &&
    (event as { phase?: unknown }).phase === "result" &&
    (event as { reason?: unknown }).reason === "stage-anchor-invalid"), true);
  assert.equal(JSON.stringify(events).includes("maxLine"), false);
  assert.equal(events.filter((event) => isArtifact(event, "03-discovery.json")).length, 1);
  assert.equal(events.some((event) =>
    typeof event === "object" && event !== null && (event as { type?: unknown }).type === "completion"), false);
});

test("an artifact-terminal session repairs within its total model-turn budget", async (t) => {
  const fixture = await fixtureRoots("runner-portable-repair-window");
  t.after(fixture.cleanup);
  const controls: Array<{ finalizationRequired: boolean } | undefined> = [];
  const requestedWith: AgentToolResult[][] = [];
  const discovery = (endLine: number) => ({
    schemaVersion: 1,
    stage: "discovery",
    summary: "Discovery recorded a repository-backed candidate.",
    observations: [],
    candidates: [{
      id: "candidate-index",
      category: "authorization",
      anchors: [{ path: "index.ts", startLine: 1, endLine, role: "source" }],
    }],
  });
  const replies: NormalizedModelReply[] = [
    {
      toolCalls: [{
        id: "write-truncated",
        name: "results.write",
        input: { path: "03-discovery.json", content: "{\"schemaVersion\":1" },
      }],
      text: null,
      structured: null,
      usage: null,
    },
    {
      toolCalls: [{
        id: "write-invalid-anchor",
        name: "results.write",
        input: { path: "03-discovery.json", content: JSON.stringify(discovery(2)) },
      }],
      text: null,
      structured: null,
      usage: null,
    },
    {
      toolCalls: [{
        id: "verify-anchor",
        name: "workspace.search",
        input: { query: "export const value", path: "index.ts" },
      }],
      text: null,
      structured: null,
      usage: null,
    },
    {
      toolCalls: [{
        id: "write-valid-anchor",
        name: "results.write",
        input: { path: "03-discovery.json", content: JSON.stringify(discovery(1)) },
      }],
      text: null,
      structured: null,
      usage: null,
    },
  ];
  const hostCalls: string[] = [];
  const session = createConstrainedWireSession({
    limits: { ...DEFAULT_AGENT_LIMITS, maxModelTurns: 4, maxToolCalls: 8 },
    signal: new AbortController().signal,
    terminalMode: "artifact-write",
    resultArtifactContract: "portable-stage-json-v1",
    resultArtifactSnapshotRoot: fixture.snapshotRoot,
    resultArtifactValidationContext: {
      dossier: {
        schemaVersion: 1,
        stageSummaries: [],
        candidates: [],
        assessments: [],
        scope: { inspected: [], unexamined: [] },
      },
    },
    host: {
      minimumOutputBytes() { return 0; },
      async call(name) {
        hostCalls.push(name);
        return name === "results.write"
          ? {
            content: "artifact-written",
            artifact: { path: "03-discovery.json", bytes: 128 },
          }
          : { content: "search-result" };
      },
    },
    upstream: { async request() { return {}; } },
    adapter: {
      nextRequest(toolResults, control) {
        requestedWith.push([...toolResults]);
        controls.push(control);
        return { operation: "messages", body: {} };
      },
      readResponse() {
        const reply = replies.shift();
        if (reply === undefined) throw new Error("test transcript exhausted");
        return reply;
      },
    },
  });

  const events: unknown[] = [];
  await collect(session.run(), events);

  assert.deepEqual(hostCalls, ["workspace.search", "results.write"]);
  assert.equal(controls[0], undefined);
  assert.equal(controls[1], undefined);
  assert.equal(controls[2], undefined);
  assert.equal(controls[3]?.finalizationRequired, true);
  assert.equal(requestedWith[1]![0]!.validationIssue, "json-invalid");
  assert.equal(requestedWith[2]![0]!.validationIssue, "stage-anchor-invalid");
  assert.equal(events.filter((event) => isArtifact(event, "03-discovery.json")).length, 1);
});

test("an artifact repair survives one text-only reply and repeats the terminal instruction", async () => {
  const controls: Array<{ finalizationRequired: boolean; artifactRepairReminder?: boolean } | undefined> = [];
  const replies: NormalizedModelReply[] = [
    {
      toolCalls: [{
        id: "write-invalid-json",
        name: "results.write",
        input: { path: "result.json", content: "{\"status\":" },
      }],
      text: null,
      structured: null,
      usage: null,
    },
    {
      toolCalls: [],
      text: "I will correct the artifact.",
      structured: null,
      usage: null,
    },
    {
      toolCalls: [{
        id: "write-valid-json",
        name: "results.write",
        input: { path: "result.json", content: "{\"status\":\"complete\"}" },
      }],
      text: null,
      structured: null,
      usage: null,
    },
  ];
  const hostInputs: unknown[] = [];
  const session = createConstrainedWireSession({
    limits: DEFAULT_AGENT_LIMITS,
    signal: new AbortController().signal,
    terminalMode: "artifact-write",
    host: {
      minimumOutputBytes() { return 0; },
      async call(_name, input) {
        hostInputs.push(input);
        return {
          content: "artifact-written",
          artifact: { path: "result.json", bytes: 21 },
        };
      },
    },
    upstream: { async request() { return {}; } },
    adapter: {
      nextRequest(_toolResults, control) {
        controls.push(control);
        return { operation: "messages", body: {} };
      },
      readResponse() {
        const reply = replies.shift();
        if (reply === undefined) throw new Error("test transcript exhausted");
        return reply;
      },
    },
  });

  const events: unknown[] = [];
  await collect(session.run(), events);

  assert.equal(controls.length, 3);
  assert.equal(controls[1], undefined);
  assert.equal(controls[2]?.finalizationRequired, true);
  assert.equal(controls[2]?.artifactRepairReminder, true);
  assert.equal(hostInputs.length, 1);
  assert.equal(events.filter((event) => isArtifact(event, "result.json")).length, 1);
});

test("an artifact repair survives one malformed provider reply inside its bounded window", async () => {
  const controls: Array<{ finalizationRequired: boolean; artifactRepairReminder?: boolean } | undefined> = [];
  let responseIndex = 0;
  const validWrite: NormalizedModelReply = {
    toolCalls: [{
      id: "write-valid-after-protocol-repair",
      name: "results.write",
      input: { path: "result.json", content: "{\"status\":\"complete\"}" },
    }],
    text: null,
    structured: null,
    usage: null,
  };
  const invalidWrite: NormalizedModelReply = {
    toolCalls: [{
      id: "write-invalid-before-protocol-repair",
      name: "results.write",
      input: { path: "result.json", content: "{\"status\":" },
    }],
    text: null,
    structured: null,
    usage: null,
  };
  const session = createConstrainedWireSession({
    limits: DEFAULT_AGENT_LIMITS,
    signal: new AbortController().signal,
    terminalMode: "artifact-write",
    host: {
      minimumOutputBytes() { return 0; },
      async call() {
        return {
          content: "artifact-written",
          artifact: { path: "result.json", bytes: 21 },
        };
      },
    },
    upstream: { async request() { return {}; } },
    adapter: {
      nextRequest(_toolResults, control) {
        controls.push(control);
        return { operation: "messages", body: {} };
      },
      readResponse() {
        responseIndex += 1;
        if (responseIndex === 1) return invalidWrite;
        if (responseIndex === 2) throw new AgentSessionError("agent_protocol_error");
        if (responseIndex === 3) return validWrite;
        throw new Error("repair must stop after the valid artifact");
      },
    },
  });

  const events: unknown[] = [];
  await collect(session.run(), events);

  assert.equal(responseIndex, 3);
  assert.equal(controls[2]?.finalizationRequired, true);
  assert.equal(controls[2]?.artifactRepairReminder, true);
  assert.equal(events.filter((event) => isArtifact(event, "result.json")).length, 1);
});

test("an artifact repair inspection permits one bounded tool call before the corrected write", async (t) => {
  const fixture = await fixtureRoots("runner-artifact-repair-bounded-inspection");
  t.after(fixture.cleanup);
  const replies: NormalizedModelReply[] = [
    {
      toolCalls: [{
        id: "write-invalid-json",
        name: "results.write",
        input: { path: "result.json", content: "{\"status\":" },
      }],
      text: null,
      structured: null,
      usage: null,
    },
    {
      toolCalls: [{
        id: "inspect-first",
        name: "workspace.search",
        input: { query: "first", path: "." },
      }],
      text: null,
      structured: null,
      usage: null,
    },
    {
      toolCalls: [{
        id: "write-corrected-json",
        name: "results.write",
        input: { path: "result.json", content: "{\"status\":\"ok\"}" },
      }],
      text: null,
      structured: null,
      usage: null,
    },
  ];
  const hostCalls: string[] = [];
  let upstreamRequests = 0;
  const session = createConstrainedWireSession({
    limits: { ...DEFAULT_AGENT_LIMITS, maxModelTurns: 3, maxToolCalls: 8 },
    signal: new AbortController().signal,
    terminalMode: "artifact-write",
    host: {
      minimumOutputBytes() { return 0; },
      async call(name) {
        hostCalls.push(name);
        return name === "results.write"
          ? { content: "artifact-written", artifact: { path: "result.json", bytes: 15 } }
          : { content: "inspection-result" };
      },
    },
    upstream: {
      async request() {
        upstreamRequests += 1;
        return {};
      },
    },
    adapter: {
      nextRequest() { return { operation: "messages", body: {} }; },
      readResponse() {
        const reply = replies.shift();
        if (reply === undefined) throw new Error("test transcript exhausted");
        return reply;
      },
    },
  });

  const events: unknown[] = [];
  await collect(session.run(), events);
  assert.equal(upstreamRequests, 3);
  assert.deepEqual(hostCalls, ["workspace.search", "results.write"]);
  assert.equal(events.filter((event) => isArtifact(event, "result.json")).length, 1);
});

test("an artifact repair window stops before a fifth repair response", async (t) => {
  const fixture = await fixtureRoots("runner-artifact-repair-turn-cap");
  t.after(fixture.cleanup);
  const invalidWrite = (id: string): NormalizedModelReply => ({
    toolCalls: [{
      id,
      name: "results.write",
      input: { path: "result.json", content: "{\"status\":" },
    }],
    text: null,
    structured: null,
    usage: null,
  });
  const replies = [
    invalidWrite("write-initial"),
    invalidWrite("write-repair-1"),
    invalidWrite("write-repair-2"),
    invalidWrite("write-repair-3"),
    invalidWrite("write-repair-4"),
  ];
  let upstreamRequests = 0;
  const session = createConstrainedWireSession({
    limits: { ...DEFAULT_AGENT_LIMITS, maxModelTurns: 5, maxToolCalls: 8 },
    signal: new AbortController().signal,
    terminalMode: "artifact-write",
    host: {
      minimumOutputBytes() { return 0; },
      async call() { return { content: "unexpected" }; },
    },
    upstream: {
      async request() {
        upstreamRequests += 1;
        return {};
      },
    },
    adapter: {
      nextRequest() { return { operation: "messages", body: {} }; },
      readResponse() {
        const reply = replies.shift();
        if (reply === undefined) throw new Error("fifth repair request must not occur");
        return reply;
      },
    },
  });

  await assert.rejects(collect(session.run(), []), { code: "agent_turn_limit" });
  assert.equal(upstreamRequests, 5);
});

test("a deep artifact repair can consume a closed anchor diagnostic before the corrected write", async (t) => {
  const fixture = await fixtureRoots("runner-deep-artifact-repair-progress");
  t.after(fixture.cleanup);
  const discovery = (endLine: number) => ({
    schemaVersion: 1,
    stage: "discovery",
    summary: "Discovery recorded a repository-backed candidate.",
    observations: [],
    candidates: [{
      id: "candidate-index",
      category: "authorization",
      anchors: [{ path: "index.ts", startLine: 1, endLine, role: "source" }],
    }],
  });
  const replies: NormalizedModelReply[] = [
    {
      toolCalls: [{
        id: "write-json-invalid-initial",
        name: "results.write",
        input: { path: "03-discovery.json", content: "{\"schemaVersion\":1" },
      }],
      text: null,
      structured: null,
      usage: null,
    },
    {
      toolCalls: [{
        id: "write-json-invalid-repair",
        name: "results.write",
        input: { path: "03-discovery.json", content: "{\"schemaVersion\":1,\"stage\":\"discovery\"" },
      }],
      text: null,
      structured: null,
      usage: null,
    },
    {
      toolCalls: [{
        id: "write-anchor-invalid",
        name: "results.write",
        input: { path: "03-discovery.json", content: JSON.stringify(discovery(2)) },
      }],
      text: null,
      structured: null,
      usage: null,
    },
    {
      toolCalls: [{ id: "inspect-anchor", name: "workspace.read", input: { path: "index.ts" } }],
      text: null,
      structured: null,
      usage: null,
    },
    {
      toolCalls: [
        { id: "ignored-search-one", name: "workspace.search", input: { query: "value", path: "." } },
        { id: "ignored-search-two", name: "workspace.search", input: { query: "export", path: "." } },
      ],
      text: null,
      structured: null,
      usage: null,
    },
    {
      toolCalls: [{
        id: "write-corrected-after-diagnostic",
        name: "results.write",
        input: { path: "03-discovery.json", content: JSON.stringify(discovery(1)) },
      }],
      text: null,
      structured: null,
      usage: null,
    },
  ];
  const hostCalls: string[] = [];
  let upstreamRequests = 0;
  const session = createConstrainedWireSession({
    limits: { ...DEFAULT_AGENT_LIMITS, maxModelTurns: 64, maxToolCalls: 256 },
    signal: new AbortController().signal,
    terminalMode: "artifact-write",
    resultArtifactContract: "portable-stage-json-v1",
    resultArtifactSnapshotRoot: fixture.snapshotRoot,
    resultArtifactValidationContext: {
      dossier: {
        schemaVersion: 1,
        stageSummaries: [],
        candidates: [],
        assessments: [],
        scope: { inspected: [], unexamined: [] },
      },
    },
    host: {
      minimumOutputBytes() { return 0; },
      async call(name) {
        hostCalls.push(name);
        return name === "results.write"
          ? { content: "artifact-written", artifact: { path: "03-discovery.json", bytes: 128 } }
          : { content: "inspection-result" };
      },
    },
    upstream: {
      async request() {
        upstreamRequests += 1;
        return {};
      },
    },
    adapter: {
      nextRequest() { return { operation: "messages", body: {} }; },
      readResponse() {
        const reply = replies.shift();
        if (reply === undefined) throw new Error("repair transcript exhausted");
        return reply;
      },
    },
  });

  const events: unknown[] = [];
  await collect(session.run(), events);

  assert.equal(upstreamRequests, 6);
  assert.deepEqual(hostCalls, ["workspace.read", "results.write"]);
  assert.equal(events.filter((event) => isArtifact(event, "03-discovery.json")).length, 1);
});

test("an artifact-terminal session corrects Portable report coverage before artifact I/O", async (t) => {
  const fixture = await fixtureRoots("runner-portable-report-coverage");
  t.after(fixture.cleanup);
  const requestedWith: AgentToolResult[][] = [];
  const anchor = { path: "index.ts", startLine: 1, endLine: 1, role: "source" as const };
  const dossier = {
    schemaVersion: 1 as const,
    stageSummaries: [],
    candidates: [{ id: "candidate-index", category: "authorization", anchors: [anchor] }],
    assessments: [{
      candidateId: "candidate-index",
      stage: "validation" as const,
      status: "confirmed" as const,
      reason: "control-not-present" as const,
      evidence: [anchor],
    }],
    scope: { inspected: ["index.ts"], unexamined: [] },
  };
  const report = (complete: boolean) => ({
    schemaVersion: 1,
    stage: "report",
    findings: complete
      ? [{
        id: "PCS-001",
        candidateId: "candidate-index",
        title: "Missing authorization control",
        severity: "high",
        confidence: "high",
        category: "authorization",
        summary: "The endpoint reaches sensitive data without a caller-bound authorization control.",
        rootCause: "The sensitive read is not constrained by the authenticated caller identity.",
        impact: "An authenticated attacker could access data outside the intended authorization boundary.",
        remediation: "Bind the sensitive query to the authenticated subject and reject unauthorized access before the read.",
        anchors: [{ ...anchor, explanation: "The source location reaches the sensitive operation without a control." }],
      }]
      : [],
    coverage: {
      inspected: ["index.ts"],
      unexamined: [],
      candidates: complete
        ? [{
          candidateId: "candidate-index",
          disposition: "reported",
          reason: "control-not-present",
          evidence: [anchor],
        }]
        : [],
    },
  });
  const replies: NormalizedModelReply[] = [
    {
      toolCalls: [{
        id: "write-incomplete-report",
        name: "results.write",
        input: { path: "sentinel-findings.json", content: JSON.stringify(report(false)) },
      }],
      text: null,
      structured: null,
      usage: null,
    },
    {
      toolCalls: [{
        id: "write-complete-report",
        name: "results.write",
        input: { path: "sentinel-findings.json", content: JSON.stringify(report(true)) },
      }],
      text: null,
      structured: null,
      usage: null,
    },
  ];
  const hostInputs: unknown[] = [];
  const session = createConstrainedWireSession({
    limits: DEFAULT_AGENT_LIMITS,
    signal: new AbortController().signal,
    terminalMode: "artifact-write",
    resultArtifactContract: "portable-stage-json-v1",
    resultArtifactSnapshotRoot: fixture.snapshotRoot,
    resultArtifactValidationContext: { dossier },
    host: {
      minimumOutputBytes() { return 0; },
      async call(_name, input) {
        hostInputs.push(input);
        return {
          content: "artifact-written",
          artifact: { path: "sentinel-findings.json", bytes: 128 },
        };
      },
    },
    upstream: { async request() { return {}; } },
    adapter: transcriptAdapter(replies, requestedWith),
  });

  const events: unknown[] = [];
  await collect(session.run(), events);

  assert.deepEqual(hostInputs, [{
    path: "sentinel-findings.json",
    content: JSON.stringify(report(true)),
  }]);
  assert.equal(requestedWith[1]![0]!.ok, false);
  assert.equal(requestedWith[1]![0]!.validationIssue, "report-coverage-candidate-missing");
  assert.match(requestedWith[1]![0]!.content, /tool_argument_invalid/);
  assert.match(requestedWith[1]![0]!.content, /report-coverage-candidate-missing/);
  assert.equal(events.filter((event) => isArtifact(event, "sentinel-findings.json")).length, 1);
  assert.equal(typeof (hostInputs[0] as { content?: unknown }).content, "string");
  assert.notEqual(
    JSON.parse((hostInputs[0] as { content: string }).content).findings[0].remediation,
    "",
  );
});

test("a Portable report shard repair repeats the findings-only contract", async (t) => {
  const fixture = await fixtureRoots("runner-portable-report-shard-repair");
  t.after(fixture.cleanup);
  const requestedWith: AgentToolResult[][] = [];
  const anchor = { path: "index.ts", startLine: 1, endLine: 1, role: "source" as const };
  const dossier = {
    schemaVersion: 1 as const,
    stageSummaries: [],
    candidates: [{ id: "candidate-index", category: "authorization", anchors: [anchor] }],
    assessments: [{
      candidateId: "candidate-index",
      stage: "validation" as const,
      status: "confirmed" as const,
      reason: "control-not-present" as const,
      evidence: [anchor],
    }],
    scope: { inspected: ["index.ts"], unexamined: [] },
  };
  const shard = createPortableCodexSecurityReportShards(dossier)[0]!;
  const validFinding = {
    id: "page-finding-01",
    candidateId: "candidate-index",
    title: "Missing authorization control on protected operation",
    severity: "high",
    confidence: "high",
    category: "authorization",
    summary: "The protected operation reaches sensitive data without binding access to the authenticated caller.",
    rootCause: "The sensitive operation does not enforce an authorization predicate for the authenticated identity.",
    impact: "An authenticated attacker could access data outside the intended authorization boundary.",
    remediation: "Bind the sensitive operation to the authenticated identity and reject unauthorized callers before access.",
    anchors: [{ ...anchor, explanation: "The source location reaches the sensitive operation without a control." }],
  };
  const replies: NormalizedModelReply[] = [
    { toolCalls: [{ id: "bad", name: "results.write", input: {
      path: "sentinel-findings.json",
      content: JSON.stringify({ schemaVersion: 1, stage: "report", findings: [] }),
    } }], text: null, structured: null, usage: null },
    { toolCalls: [{ id: "good", name: "results.write", input: {
      path: "sentinel-findings.json",
      content: JSON.stringify({ schemaVersion: 1, stage: "report", findings: [validFinding] }),
    } }], text: null, structured: null, usage: null },
  ];
  const hostInputs: unknown[] = [];
  const session = createConstrainedWireSession({
    limits: DEFAULT_AGENT_LIMITS,
    signal: new AbortController().signal,
    terminalMode: "artifact-write",
    resultArtifactContract: "portable-stage-json-v1",
    resultArtifactSnapshotRoot: fixture.snapshotRoot,
    resultArtifactValidationContext: { dossier: shard.dossier, reportShard: shard },
    host: {
      minimumOutputBytes() { return 0; },
      async call(_name, input) {
        hostInputs.push(input);
        return { content: "artifact-written", artifact: { path: "sentinel-findings.json", bytes: 128 } };
      },
    },
    upstream: { async request() { return {}; } },
    adapter: transcriptAdapter(replies, requestedWith),
  });

  await collect(session.run(), []);

  assert.equal(hostInputs.length, 1);
  assert.match(requestedWith[1]![0]!.content, /containing only schemaVersion:1/i);
  assert.match(requestedWith[1]![0]!.content, /Do not include summary, observations, scope, coverage/i);
  assert.equal(requestedWith[1]![0]!.content.includes("Include a non-empty summary"), false);
});

test("the constrained session rejects nonexistent and out-of-range evidence before artifact I/O", async (t) => {
  const fixture = await fixtureRoots("runner-vulnhunter-evidence");
  t.after(fixture.cleanup);
  const report = (path: string, startLine: number, endLine = startLine) => ({
    schemaVersion: 1,
    findings: [{
      id: "VULN-001",
      title: "Synthetic evidence boundary",
      severity: "high",
      confidence: "medium",
      cwe: ["CWE-20"],
      summary: "Synthetic finding used to verify the evidence boundary.",
      rootCause: "Unvalidated input reaches a sensitive operation.",
      entryPoint: "HTTP request field",
      dataFlow: "request -> validation -> sink",
      impact: "Unexpected behavior.",
      remediation: "Validate the input before the sink.",
      severityRationale: "A reachable sensitive operation is affected.",
      validation: {
        summary: "Static trace retained after defensive review.",
        limitations: ["Static inspection only."],
      },
      evidence: [{
        path,
        startLine,
        endLine,
        role: "sink",
        explanation: "The synthetic sink is reached here.",
      }],
    }],
  });
  const requestedWith: AgentToolResult[][] = [];
  const replies: NormalizedModelReply[] = [
    {
      toolCalls: [{
        id: "write-missing",
        name: "results.write",
        input: {
          path: "sentinel-findings.json",
          content: JSON.stringify(report("src/missing.ts", 1)),
        },
      }],
      text: null,
      structured: null,
      usage: null,
    },
    {
      toolCalls: [{
        id: "write-out-of-range",
        name: "results.write",
        input: {
          path: "sentinel-findings.json",
          content: JSON.stringify(report("index.ts", 99)),
        },
      }],
      text: null,
      structured: null,
      usage: null,
    },
    {
      toolCalls: [{
        id: "write-valid-evidence",
        name: "results.write",
        input: {
          path: "sentinel-findings.json",
          content: JSON.stringify(report("index.ts", 1)),
        },
      }],
      text: null,
      structured: null,
      usage: null,
    },
    { toolCalls: [], text: "complete", structured: { status: "complete" }, usage: null },
  ];
  const hostInputs: unknown[] = [];
  const session = createConstrainedWireSession({
    limits: DEFAULT_AGENT_LIMITS,
    signal: new AbortController().signal,
    resultArtifactContract: "vulnhunter-report-v1",
    resultArtifactSnapshotRoot: fixture.snapshotRoot,
    host: {
      minimumOutputBytes() {
        return 0;
      },
      async call(_name, input) {
        hostInputs.push(input);
        return { content: "artifact-written" };
      },
    },
    upstream: { async request() { return {}; } },
    adapter: transcriptAdapter(replies, requestedWith),
  });

  await collect(session.run(), []);

  assert.equal(hostInputs.length, 1);
  assert.deepEqual(hostInputs[0], {
    path: "sentinel-findings.json",
    content: JSON.stringify(report("index.ts", 1)),
  });
  assert.equal(requestedWith[1]![0]!.ok, false);
  assert.equal(requestedWith[2]![0]!.ok, false);
  assert.equal(requestedWith[3]![0]!.ok, undefined);
});

test("the constrained session rejects an unapproved report path before artifact I/O", async () => {
  const requestedWith: AgentToolResult[][] = [];
  const replies: NormalizedModelReply[] = [
    {
      toolCalls: [{
        id: "write-wrong-path",
        name: "results.write",
        input: {
          path: "other-report.json",
          content: JSON.stringify({ schemaVersion: 1, findings: [] }),
        },
      }],
      text: null,
      structured: null,
      usage: null,
    },
    { toolCalls: [], text: "complete", structured: { status: "complete" }, usage: null },
  ];
  let minimumOutputCalls = 0;
  let hostCalls = 0;
  const session = createConstrainedWireSession({
    limits: DEFAULT_AGENT_LIMITS,
    signal: new AbortController().signal,
    resultArtifactContract: "vulnhunter-report-v1",
    host: {
      minimumOutputBytes() {
        minimumOutputCalls += 1;
        return 0;
      },
      async call() {
        hostCalls += 1;
        return { content: "artifact-written" };
      },
    },
    upstream: { async request() { return {}; } },
    adapter: transcriptAdapter(replies, requestedWith),
  });

  await collect(session.run(), []);

  assert.equal(minimumOutputCalls, 0);
  assert.equal(hostCalls, 0);
  assert.equal(requestedWith[1]![0]!.ok, false);
  assert.match(requestedWith[1]![0]!.content, /tool_argument_invalid/);
});

test("the constrained session rejects a call after results.write before host I/O", async () => {
  const toolCalls: string[] = [];
  const session = createConstrainedWireSession({
    limits: DEFAULT_AGENT_LIMITS,
    signal: new AbortController().signal,
    host: recordingToolHost(toolCalls),
    upstream: { async request() { return {}; } },
    adapter: transcriptAdapter([{
      toolCalls: [
        { id: "write-1", name: "results.write", input: { path: "report.json", content: "{}" } },
        { id: "read-1", name: "workspace.read", input: { path: "index.ts" } },
      ],
      text: null,
      structured: null,
      usage: null,
    }]),
  });

  await assert.rejects(collect(session.run(), []), { code: "agent_protocol_error" });
  assert.deepEqual(toolCalls, []);
});

test("the constrained session rejects duplicate results.write calls before host I/O", async () => {
  const toolCalls: string[] = [];
  const session = createConstrainedWireSession({
    limits: DEFAULT_AGENT_LIMITS,
    signal: new AbortController().signal,
    host: recordingToolHost(toolCalls),
    upstream: { async request() { return {}; } },
    adapter: transcriptAdapter([{
      toolCalls: [
        { id: "write-1", name: "results.write", input: { path: "report-one.json", content: "{}" } },
        { id: "write-2", name: "results.write", input: { path: "report-two.json", content: "{}" } },
      ],
      text: null,
      structured: null,
      usage: null,
    }]),
  });

  await assert.rejects(collect(session.run(), []), { code: "agent_protocol_error" });
  assert.deepEqual(toolCalls, []);
});

test("remaining output budget prevents results.write before host I/O", async (t) => {
  const fixture = await fixtureRoots("runner-write-budget");
  t.after(fixture.cleanup);
  const reply = chatToolCall(
    "results.write",
    { path: "must-not-exist.json", content: "{}" },
    "write-without-budget",
  );
  const responseBytes = Buffer.byteLength(JSON.stringify(reply), "utf8");
  const session = await createAgentSession({
    ...sessionSpec(fixture, "openai-chat", "gemini-api", { maxOutputBytes: responseBytes + 1 }),
    probe: capability(),
  }, fakeOpenAiChat([reply]));

  await assert.rejects(collect(session.run(), []), { code: "agent_output_byte_limit" });
  assert.equal(await fileExists(join(fixture.artifactRoot, "must-not-exist.json")), false);
});

test("malformed frames fail safely and absent usage stays null", async (t) => {
  const malformedFixture = await fixtureRoots("malformed-frame");
  const usageFixture = await fixtureRoots("usage-fields");
  t.after(malformedFixture.cleanup);
  t.after(usageFixture.cleanup);

  const malformed = fakeOpenAiChat([{ type: "response.output_text.delta", delta: "ignored" }]);
  const malformedSession = await createAgentSession({
    ...sessionSpec(malformedFixture, "openai-chat", "gemini-api"),
    probe: capability(),
  }, malformed);
  await assert.rejects(collect(malformedSession.run(), []), { code: "agent_protocol_error" });

  const usageSession = await createAgentSession({
    ...sessionSpec(usageFixture, "openai-chat", "gemini-api"),
    probe: capability(),
  }, fakeOpenAiChat([{
    choices: [{ message: { content: "plain" } }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 3 },
      completion_tokens_details: { reasoning_tokens: 2 },
    },
  }]));
  const usageEvents: unknown[] = [];
  await collect(usageSession.run(), usageEvents);
  assert.deepEqual(usageEvents.find(isUsage), {
    type: "usage",
    usage: {
      inputTokens: 10,
      cachedInputTokens: 3,
      cacheWriteInputTokens: null,
      outputTokens: 5,
      reasoningTokens: 2,
    },
  });
});

test("OpenAI Responses and Anthropic Messages complete the same constrained artifact loop", async (t) => {
  const responsesFixture = await fixtureRoots("responses-loop");
  const anthropicFixture = await fixtureRoots("anthropic-loop");
  t.after(responsesFixture.cleanup);
  t.after(anthropicFixture.cleanup);

  const responses = fakeTranscript([
    responsesToolCall("workspace.read", { path: "index.ts" }, "response-read"),
    responsesToolCall("results.write", { path: "report.json", content: JSON.stringify({ status: "ok" }) }, "response-write"),
    responsesFinalStructured({ status: "ok" }),
  ]);
  const responseSession = await createAgentSession({
    ...sessionSpec(responsesFixture, "openai-responses", "openai-api"),
    probe: capability(),
  }, responses);
  const responseEvents: unknown[] = [];
  await collect(responseSession.run(), responseEvents);
  assert.equal(responseEvents.some((event) => isArtifact(event, "report.json")), true);

  const anthropic = fakeTranscript([
    anthropicToolCall("workspace.read", { path: "index.ts" }, "anthropic-read"),
    anthropicToolCall("results.write", { path: "report.json", content: JSON.stringify({ status: "ok" }) }, "anthropic-write"),
    anthropicFinalStructured({ status: "ok" }),
  ]);
  const anthropicSession = await createAgentSession({
    ...sessionSpec(anthropicFixture, "anthropic-messages", "anthropic-api"),
    probe: capability(),
  }, anthropic);
  const anthropicEvents: unknown[] = [];
  await collect(anthropicSession.run(), anthropicEvents);
  assert.equal(anthropicEvents.some((event) => isArtifact(event, "report.json")), true);
});

test("Anthropic Messages retries a malformed report and writes only the corrected JSON string", async (t) => {
  const fixture = await fixtureRoots("anthropic-vulnhunter-report");
  t.after(fixture.cleanup);
  const report = {
    schemaVersion: 1,
    findings: [],
  };
  const upstream = fakeTranscript([
    anthropicToolCall("results.write", {
      path: "sentinel-findings.json",
      content: "{malformed",
    }, "write-invalid"),
    anthropicToolCall("results.write", {
      path: "sentinel-findings.json",
      content: JSON.stringify(report),
    }, "write-valid"),
    anthropicFinalStructured({ status: "ok" }),
  ]);
  const session = await createAgentSession({
    ...sessionSpec(fixture, "anthropic-messages", "anthropic-api"),
    resultArtifactContract: "vulnhunter-report-v1",
    probe: capability(),
  }, upstream);

  await collect(session.run(), []);

  const written = JSON.parse(
    await readFile(join(fixture.artifactRoot, "sentinel-findings.json"), "utf8"),
  ) as unknown;
  assert.deepEqual(written, report);
});

test("wire operations are route-agnostic for custom, MiMo, and xAI OAuth sessions", async (t) => {
  const fixture = await fixtureRoots("route-agnostic-wire");
  t.after(fixture.cleanup);
  const selected = model("account-visible/model:exact");
  const cases = [
    {
      routeKind: "custom-openai-compatible",
      protocol: "openai-chat",
      operation: "chat-completions",
      response: chatFinalText("done"),
    },
    {
      routeKind: "custom-anthropic-compatible",
      protocol: "anthropic-messages",
      operation: "messages",
      response: anthropicFinalStructured({ status: "ok" }),
    },
    {
      routeKind: "mimo-token-plan",
      protocol: "openai-chat",
      operation: "chat-completions",
      response: chatFinalText("done"),
    },
    {
      routeKind: "xai-oauth",
      protocol: "xai-oauth-responses",
      operation: "responses",
      response: responsesFinalStructured({ status: "ok" }),
    },
  ] as const;

  for (const candidate of cases) {
    const requests: AgentUpstreamRequest[] = [];
    const session = await createAgentSession({
      ...sessionSpec(fixture, "openai-chat", candidate.routeKind),
      protocol: candidate.protocol,
      model: selected,
      probe: capability(),
    }, {
      async request(request) {
        requests.push(request);
        return candidate.response;
      },
    });
    await collect(session.run(), []);
    assert.equal(wireOperation(requests[0]), candidate.operation);
    assert.equal(requests[0] !== undefined && "url" in requests[0], false);
    assert.equal((requests[0]?.body as { model?: unknown }).model, selected.id);
  }
});

function capability(): ModelCapabilities {
  return {
    tools: "supported",
    artifactOutput: "supported",
    structuredOutput: "supported",
    boundedExecution: "supported",
    osIsolation: "unknown",
    streaming: "unknown",
    usage: "unknown",
    cancellation: "unknown",
  };
}

function model(id: string): ProviderModel {
  return {
    connectionId: "connection-a",
    id,
    displayName: id,
    contextWindow: null,
    capabilities: capability(),
    pricing: null,
    discoveredAt: "2026-08-11T00:00:00.000Z",
    source: "provider-api",
  };
}

async function fixtureRoots(name: string) {
  const root = await mkdtemp(join(process.cwd(), `.test-agent-${name}-`));
  const snapshotRoot = join(root, "snapshot");
  const artifactRoot = join(root, "artifacts");
  await mkdir(snapshotRoot);
  await mkdir(artifactRoot, { mode: 0o700 });
  await writeFile(join(snapshotRoot, "index.ts"), "export const value = 1;\n");
  return {
    snapshotRoot,
    artifactRoot,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function sessionSpec(
  fixture: Awaited<ReturnType<typeof fixtureRoots>>,
  protocol: "openai-responses" | "openai-chat" | "anthropic-messages" | "xai-oauth-responses",
  routeKind: string,
  limits: Partial<typeof DEFAULT_AGENT_LIMITS> = {},
) {
  return {
    connectionId: "connection-a",
    routeKind,
    protocol,
    model: model("account-visible"),
    snapshotRoot: fixture.snapshotRoot,
    artifactRoot: fixture.artifactRoot,
    instructions: "Inspect the snapshot and report through the allowed tools.",
    limits: { ...DEFAULT_AGENT_LIMITS, ...limits },
    signal: new AbortController().signal,
  };
}

function probeSpec(fixture: Awaited<ReturnType<typeof fixtureRoots>>) {
  const spec = sessionSpec(fixture, "openai-chat", "gemini-api");
  return {
    snapshotRoot: spec.snapshotRoot,
    artifactRoot: spec.artifactRoot,
    instructions: spec.instructions,
    limits: spec.limits,
    signal: spec.signal,
  };
}

function alwaysRequestsWorkspaceRead() {
  let modelCalls = 0;
  return {
    get modelCalls() {
      return modelCalls;
    },
    async request(request: AgentUpstreamRequest) {
      modelCalls += 1;
      const body = request.body as { model?: unknown };
      assert.equal(body.model, "account-visible");
      return {
        choices: [{
          message: {
            tool_calls: [{
              id: `tool-${modelCalls}`,
              type: "function",
              function: {
                name: "workspace_read",
                arguments: JSON.stringify({ path: "index.ts" }),
              },
            }],
          },
        }],
      };
    },
  };
}

function fakeOpenAiChat(replies: unknown[]) {
  const requests: AgentUpstreamRequest[] = [];
  const modelIds: unknown[] = [];
  return {
    requests,
    modelIds,
    async request(request: AgentUpstreamRequest) {
      const body = request.body as { model?: unknown };
      requests.push(request);
      modelIds.push(body.model);
      const reply = replies.shift();
      if (reply === undefined) throw new Error("fake transcript exhausted");
      return reply;
    },
  };
}

function fakeTranscript(replies: unknown[]) {
  return {
    async request() {
      const reply = replies.shift();
      if (reply === undefined) throw new Error("fake transcript exhausted");
      return reply;
    },
  };
}

function transcriptAdapter(
  replies: NormalizedModelReply[],
  requestedWith: AgentToolResult[][] = [],
) {
  return {
    nextRequest(toolResults: readonly AgentToolResult[]) {
      requestedWith.push([...toolResults]);
      return { operation: "chat-completions" as const, body: {} };
    },
    readResponse() {
      const reply = replies.shift();
      if (reply === undefined) throw new Error("test transcript exhausted");
      return reply;
    },
  };
}

function recordingToolHost(toolCalls: string[]) {
  return {
    minimumOutputBytes() {
      return 0;
    },
    async call(name: AgentToolCall["name"]) {
      toolCalls.push(name);
      return { content: `${name}-result` };
    },
  };
}

function chatToolCall(name: string, input: Record<string, unknown>, id: string) {
  return {
    choices: [{
      message: {
        tool_calls: [{ id, type: "function", function: { name: portableWireToolName(name), arguments: JSON.stringify(input) } }],
      },
    }],
  };
}

function chatFinalText(content: string) {
  return { choices: [{ message: { content } }] };
}

function chatFinalStructured(value: Record<string, unknown>) {
  return { choices: [{ message: { content: JSON.stringify(value) } }] };
}

function responsesToolCall(name: string, input: Record<string, unknown>, id: string) {
  return {
    id: `response-${id}`,
    output: [{ type: "function_call", call_id: id, name: portableWireToolName(name), arguments: JSON.stringify(input) }],
  };
}

function responsesFinalStructured(value: Record<string, unknown>) {
  return {
    id: "response-final",
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }],
  };
}

function anthropicToolCall(name: string, input: Record<string, unknown>, id: string) {
  return { content: [{ type: "tool_use", id, name: portableWireToolName(name), input }], stop_reason: "tool_use" };
}

function portableWireToolName(name: string): string {
  const wireName = ({
    "workspace.list": "workspace_list",
    "workspace.read": "workspace_read",
    "workspace.search": "workspace_search",
    "results.write": "results_write",
  } as Record<string, string>)[name];
  if (wireName === undefined) throw new Error("unknown test tool");
  return wireName;
}

function anthropicFinalStructured(value: Record<string, unknown>) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], stop_reason: "end_turn" };
}

function pickAgentFacts(report: { capabilities: Partial<ModelCapabilities> }) {
  return {
    tools: report.capabilities.tools,
    artifactOutput: report.capabilities.artifactOutput,
    structuredOutput: report.capabilities.structuredOutput,
    boundedExecution: report.capabilities.boundedExecution,
  };
}

function isArtifact(value: unknown, path: string): boolean {
  return typeof value === "object" && value !== null &&
    (value as { type?: unknown }).type === "artifact" &&
    (value as { path?: unknown }).path === path;
}

function isCancellation(value: unknown, remote: boolean): boolean {
  return typeof value === "object" && value !== null &&
    (value as { type?: unknown }).type === "cancellation" &&
    (value as { remote?: unknown }).remote === remote;
}

function isUsage(value: unknown): boolean {
  return typeof value === "object" && value !== null &&
    (value as { type?: unknown }).type === "usage";
}

function isCompletedTool(value: unknown): boolean {
  return typeof value === "object" && value !== null &&
    (value as { type?: unknown }).type === "tool" &&
    (value as { phase?: unknown }).phase === "result";
}

async function collect(events: AsyncIterable<unknown>, output: unknown[]): Promise<unknown[]> {
  for await (const event of events) output.push(event);
  return output;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function wireOperation(request: unknown): unknown {
  return typeof request === "object" && request !== null
    ? (request as { operation?: unknown }).operation
    : undefined;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function noToolHost() {
  return {
    minimumOutputBytes() {
      return 0;
    },
    async call() {
      throw new Error("no tool call expected");
    },
  };
}

function finalOnlyAdapter() {
  return {
    nextRequest() {
      return { operation: "chat-completions" as const, body: {} };
    },
    readResponse() {
      throw new Error("no response expected");
    },
  };
}

function manualTimer(): AgentSessionTimer & { fireNext(): void } {
  let nextId = 0;
  const callbacks = new Map<number, { delayMs: number; callback: () => void }>();
  return {
    setTimeout(callback, delayMs) {
      nextId += 1;
      callbacks.set(nextId, { delayMs, callback });
      return nextId;
    },
    clearTimeout(handle) {
      if (typeof handle === "number") callbacks.delete(handle);
    },
    fireNext() {
      const next = [...callbacks.entries()]
        .sort((left, right) => left[1].delayMs - right[1].delayMs || left[0] - right[0])[0];
      if (next === undefined) throw new Error("no scheduled timer");
      callbacks.delete(next[0]);
      next[1].callback();
    },
  };
}

async function withTestDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(Object.assign(new Error("test timeout"), { code: "test_timeout" })), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
