import { createPortableCodexSecurityDossier } from "../scanners/portable-codex-security-dossier.js";
import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderModel } from "@csb/shared";

import { createOpenAiResponsesWireAdapter } from "./openai-responses-session.js";
import { buildPortableCodexSecurityStagePrompt, PORTABLE_CODEX_SECURITY_STAGES } from "../scanners/portable-codex-security-profile.js";
import { ContextBudgetEstimator, completionContextReserve } from "./context-budget.js";
import { AGENT_ARTIFACT_REPAIR_REMINDER, AGENT_PORTABLE_FINALIZATION_REMINDER, type AgentWireRequest } from "./session-types.js";

test("a large quoted source page fits Standard context without dropping source or raising the context ceiling", () => {
  const content = '{\n' + '  "key": "value",\n'.repeat(16_500) + '}\n';
  const source = { path: "i18n.tsx", lineCount: 16_502, content };
  const instructions = "g".repeat(10_000) + buildPortableCodexSecurityStagePrompt(
    PORTABLE_CODEX_SECURITY_STAGES.find(stage => stage.id === "discovery")!, {
      snapshotRoot: "/snapshot", artifactRoot: "/artifacts", scanMode: "standard",
      deepCoveragePartition: { index: 0, total: 1, paths: [source.path], sourceFiles: [source] },
    });
  const request = (cap: number) => createOpenAiResponsesWireAdapter({
    model: model("grok-4.6"), instructions, maxCompletionTokens: cap,
    resultArtifactContract: "portable-stage-json-v1",
    resultArtifactValidationContext: {
      dossier: createPortableCodexSecurityDossier(), expectedArtifactPath: "03-discovery.json",
      requireDiscoveryCandidateContext: true,
    },
  }).nextRequest([]).body;
  const standard = request(16_384);
  const projected = (standard as { input: Array<{content: string}> }).input[0]!.content;
  assert.ok(projected.includes(JSON.stringify([source])), "every original source byte remains projected");
  const estimate = (body: unknown) => new ContextBudgetEstimator().estimate(Buffer.byteLength(JSON.stringify(body))) + completionContextReserve(body);
  assert.ok(estimate(standard) <= 300_000, `estimated ${estimate(standard)}`);
  assert.ok(estimate(request(32_768)) > 300_000, `estimated ${estimate(request(32_768))}`);
});

test("OpenAI Responses encodes declared tool names and decodes only portable wire calls", () => {
  const adapter = createOpenAiResponsesWireAdapter({
    model: model("gpt-5"),
    instructions: "Use only the declared workspace tools.",
  });

  const request = responsesBody(adapter.nextRequest([]));
  assert.deepEqual(request.tools.map((tool) => tool.name), [
    "workspace_list",
    "workspace_read",
    "workspace_search",
    "results_write",
  ]);
  assert.match(request.tools[0]!.description, /virtual root.*\./i);
  assert.match(request.tools[1]!.description, /repository-relative/i);
  assert.match(request.tools[2]!.description, /repository-relative/i);
  assert.match(request.tools[3]!.description, /result-relative/i);

  const normalized = adapter.readResponse({
    id: "response-1",
    output: [{
      type: "function_call",
      call_id: "call-read-1",
      name: "workspace_read",
      arguments: '{"path":"report.txt"}',
    }],
  });
  assert.deepEqual(normalized.toolCalls, [{
    id: "call-read-1",
    name: "workspace.read",
    input: { path: "report.txt" },
  }]);

  assert.throws(() => adapter.readResponse({
    id: "response-2",
    output: [{
      type: "function_call",
      call_id: "call-dotted-1",
      name: "workspace.read",
      arguments: "{}",
    }],
  }), { code: "agent_protocol_error" });
});

test("Responses projects task/source once as persistent system input and continues with tool deltas", () => {
  const adapter = createOpenAiResponsesWireAdapter({
    model: model("grok-4.5"),
    instructions: "Inspect only the supplied workspace snapshot.",
  });

  const firstRequest = responseBody(adapter.nextRequest([]));
  assert.equal(firstRequest.instructions, undefined);
  assert.deepEqual(firstRequest.input, [{
    role: "system",
    content: "Inspect only the supplied workspace snapshot.",
  }, {
    role: "user",
    content: "Continue the assigned task using the supplied instructions and tool results.",
  }]);
  assert.equal(JSON.stringify(firstRequest).split("Inspect only the supplied workspace snapshot.").length - 1, 1);

  adapter.readResponse({
    id: "response-turn-1",
    output: [
      {
        type: "function_call",
        call_id: "call-list-1",
        name: "workspace_list",
        arguments: "{}",
      },
      {
        type: "function_call",
        call_id: "call-read-1",
        name: "workspace_read",
        arguments: '{"path":"package.json"}',
      },
    ],
  });

  const continuation = responseBody(adapter.nextRequest([
    { callId: "call-list-1", name: "workspace.list", content: "package.json" },
    { callId: "call-read-1", name: "workspace.read", content: "{\"name\":\"fixture\"}" },
  ]));

  assert.equal("instructions" in continuation, false);
  assert.equal(continuation.previous_response_id, "response-turn-1");
  assert.deepEqual(continuation.input, [
    {
      type: "function_call_output",
      call_id: "call-list-1",
      output: "package.json",
    },
    {
      type: "function_call_output",
      call_id: "call-read-1",
      output: "{\"name\":\"fixture\"}",
    },
  ]);
});

test("OpenAI Responses writes reasoning effort only when the exact model publishes it", () => {
  const published = createOpenAiResponsesWireAdapter({
    model: model("gpt-5", {
      reasoningEffort: { options: ["low", "high"], default: "high" },
    }),
    instructions: "Inspect the snapshot.",
    reasoningEffort: "high",
  });
  const unmanaged = createOpenAiResponsesWireAdapter({
    model: model("gpt-5"),
    instructions: "Inspect the snapshot.",
  });

  assert.deepEqual(responseBody(published.nextRequest([])).reasoning, { effort: "high" });
  assert.equal("reasoning" in responseBody(unmanaged.nextRequest([])), false);
});

test("OpenAI Responses accepts one fenced JSON completion as structured output", () => {
  const adapter = createOpenAiResponsesWireAdapter({
    model: model("grok-4.5"),
    instructions: "Return the final result as JSON.",
  });

  const normalized = adapter.readResponse({
    id: "response-final",
    output: [{
      type: "message",
      content: [{ type: "output_text", text: "```json\n{\"ok\":true}\n```" }],
    }],
  });

  assert.deepEqual(normalized.structured, { ok: true });
});

test("OpenAI Responses closes the tool surface after results.write is consumed", () => {
  const adapter = createOpenAiResponsesWireAdapter({
    model: model("grok-4.5"),
    instructions: "Write one artifact, then return JSON.",
  });
  adapter.readResponse({
    id: "response-write",
    output: [{
      type: "function_call",
      call_id: "write-1",
      name: "results_write",
      arguments: '{"path":"architecture.json","content":{"stage":"architecture"}}',
    }],
  });

  const finalRequest = adapter.nextRequest([{
    callId: "write-1",
    name: "results.write",
    content: '{"path":"architecture.json","bytes":24}',
  }]);

  const body = finalRequest.body as Record<string, unknown>;
  assert.equal("tools" in body, false);
  assert.throws(() => adapter.readResponse({
    id: "response-late-tool",
    output: [{
      type: "function_call",
      call_id: "late-list",
      name: "workspace_list",
      arguments: "{}",
    }],
  }), { code: "agent_protocol_error" });
});

test("OpenAI Responses exposes only the required artifact tool during reserved finalization", () => {
  const adapter = createOpenAiResponsesWireAdapter({
    model: model("portable-model"),
    instructions: "Write the required artifact before completing.",
  });
  const request = responseBody((adapter.nextRequest as (
    results: readonly [],
    control: { finalizationRequired: true; artifactRepairReminder: true },
  ) => AgentWireRequest)([], { finalizationRequired: true, artifactRepairReminder: true }));
  const tools = request.tools as Array<{ name: string }>;
  const input = request.input as Array<{ role: string; content: string }>;

  assert.deepEqual(tools.map((tool) => tool.name), ["results_write"]);
  assert.equal(request.tool_choice, "required");
  assert.match(input.find(item => item.role === "user")?.content ?? "", /call results\.write now/i);
});

test("OpenAI Responses keeps the VulnHunter result tool on the strict string contract", () => {
  const structured = createOpenAiResponsesWireAdapter({
    model: model("generic-responses-model"),
    instructions: "Submit one structured result artifact.",
    resultArtifactContract: "vulnhunter-report-v1",
  });
  const legacy = createOpenAiResponsesWireAdapter({
    model: model("generic-responses-model"),
    instructions: "Submit one text result artifact.",
  });

  const structuredTool = responsesBody(structured.nextRequest([])).tools[3]!;
  const legacyTool = responsesBody(legacy.nextRequest([])).tools[3]!;
  const structuredProperties = (structuredTool.parameters as { properties: Record<string, unknown> }).properties;
  const legacyProperties = (legacyTool.parameters as { properties: Record<string, unknown> }).properties;

  assert.equal(structuredTool.strict, true);
  assert.deepEqual(structuredProperties.content, { type: "string", minLength: 1 });
  assert.deepEqual(structuredProperties.path, { type: "string", minLength: 1 });
  assert.equal(legacyTool.strict, true);
  assert.deepEqual(legacyProperties.content, { type: "string", minLength: 1 });
  assert.equal(responsesBody(structured.nextRequest([{
    callId: "invalid-write",
    name: "results.write",
    content: JSON.stringify({ error: "tool_argument_invalid" }),
    ok: false,
  }])).tools.length, 4);
});

test("OpenAI Responses Portable allows optional stage fields and keeps workspace tools strict", () => {
  const adapter = createOpenAiResponsesWireAdapter({
    model: model("portable-model"), instructions: "Write the stage object.",
    resultArtifactContract: "portable-stage-json-v1",
  });
  const tools = responsesBody(adapter.nextRequest([])).tools;
  assert.equal(tools[3]!.strict, false);
  const properties = (tools[3]!.parameters as { properties: Record<string, { type: string }> }).properties;
  assert.equal(properties.content!.type, "object");
  assert.equal(tools.slice(0, 3).every((tool) => tool.strict === true), true);
});

function responsesBody(request: AgentWireRequest): {
  tools: Array<{ name: string; description: string; strict?: boolean; parameters?: unknown }>;
} {
  assert.equal(request.operation, "responses");
  return request.body as {
    tools: Array<{ name: string; description: string; strict?: boolean; parameters?: unknown }>;
  };
}

function responseBody(request: AgentWireRequest): Record<string, unknown> {
  assert.equal(request.operation, "responses");
  return request.body as Record<string, unknown>;
}

function model(id: string, patch: Partial<ProviderModel> = {}): ProviderModel {
  return {
    connectionId: "connection-a",
    id,
    displayName: id,
    contextWindow: null,
    capabilities: {
      tools: "unknown",
      artifactOutput: "unknown",
      structuredOutput: "unknown",
      boundedExecution: "unknown",
      osIsolation: "unknown",
      streaming: "unknown",
      usage: "unknown",
      cancellation: "unknown",
    },
    pricing: null,
    discoveredAt: "2026-08-11T00:00:00.000Z",
    source: "provider-api",
    ...patch,
  };
}


test("a malformed Responses frame never becomes the continuation cursor", () => {
  const adapter = createOpenAiResponsesWireAdapter({ model: model("gpt-test"), instructions: "Inspect." });
  adapter.readResponse({ id: "accepted-response", output: [] });
  const rejected = { id: "bad-response", output: [{ type: "function_call", call_id: "bad", name: "results_write", arguments: "{" }], usage: { input_tokens: 20, output_tokens: 7 } };
  assert.throws(() => adapter.readResponse(rejected), { code: "agent_protocol_error" });
  assert.equal(responseBody(adapter.nextRequest([])).previous_response_id, "accepted-response");
  assert.equal(adapter.readUsage!(rejected).outputTokens, 7);
});


test("openai-responses-session exposes only the current Portable stage contract", () => {
  const adapter = createOpenAiResponsesWireAdapter({
    model: model("MiniMax-M3"), instructions: "Write the current stage.",

    resultArtifactContract: "portable-stage-json-v1",
    resultArtifactValidationContext: { dossier: createPortableCodexSecurityDossier(), expectedArtifactPath: "02-threat-model.json" },
  });
  const body = adapter.nextRequest([]).body as { tools: Array<any> };
  const tool = body.tools.find((entry) => (entry.function?.name ?? entry.name) === "results_write");
  const schema = tool.input_schema ?? tool.parameters ?? tool.function.parameters;
  assert.deepEqual(schema.properties.path.enum, ["02-threat-model.json"]);
  assert.deepEqual(schema.properties.content.properties.stage.enum, ["threat-model"]);
  assert.deepEqual(schema.properties.content.required, ["schemaVersion", "stage", "summary", "observations"]);
  assert.equal("candidates" in schema.properties.content.properties, false);
});


test("Responses replays pending tool outputs after a malformed continuation until accepted", () => {
  const adapter = createOpenAiResponsesWireAdapter({ model: model("gpt-test"), instructions: "Inspect." });
  adapter.readResponse({ id: "read-response", output: [{ type: "function_call", call_id: "read-1", name: "workspace_read", arguments: '{"path":"index.ts"}' }] });
  const result = { callId: "read-1", name: "workspace.read" as const, content: "file contents" };
  const first = responseBody(adapter.nextRequest([result]));
  const expectedOutput = { type: "function_call_output", call_id: "read-1", output: "file contents" };
  assert.deepEqual(first.input, [expectedOutput]);
  assert.throws(() => adapter.readResponse({ id: "bad-response", output: [{ type: "function_call", call_id: "bad", name: "results_write", arguments: "{" }] }), { code: "agent_protocol_error" });
  const retry = responseBody(adapter.nextRequest([], { finalizationRequired: true, artifactRepairReminder: true }));
  assert.equal(retry.previous_response_id, "read-response");
  const retryInput = retry.input as Array<Record<string, unknown>>;
  assert.equal(retryInput.length, 2);
  assert.deepEqual(retryInput[0], expectedOutput);
  assert.equal(retryInput[1]!.role, "user");
  assert.match(String(retryInput[1]!.content), /results.write/);
  assert.throws(() => adapter.readResponse({ id: "bad-again", output: null }), { code: "agent_protocol_error" });
  assert.deepEqual(responseBody(adapter.nextRequest([], { finalizationRequired: true, artifactRepairReminder: true })).input, retryInput);
  adapter.readResponse({ id: "accepted-response", output: [{ type: "function_call", call_id: "read-2", name: "workspace_read", arguments: '{"path":"other.ts"}' }] });
  const next = responseBody(adapter.nextRequest([{ callId: "read-2", name: "workspace.read", content: "other contents" }]));
  assert.equal(next.previous_response_id, "accepted-response");
  assert.deepEqual(next.input, [{ type: "function_call_output", call_id: "read-2", output: "other contents" }]);
  adapter.readResponse({ id: "complete", output: [] });
  assert.deepEqual(responseBody(adapter.nextRequest([])).input, [{ role: "user", content: "Continue the assigned task using the supplied instructions and tool results." }]);
});


test("Portable finalization preserves collected tool output before explicit consolidation guidance", () => {
  for (const resultArtifactContract of ["portable-stage-json-v1", undefined] as const) {
    const adapter = createOpenAiResponsesWireAdapter({
      model: model("portable-model"), instructions: "Inspect source and write a stage artifact.",

      resultArtifactContract,
    });
    adapter.nextRequest([]);
    adapter.readResponse({ id: "response-read", output: [{ type: "function_call", call_id: "read-1", name: "workspace_read", arguments: '{"path":"index.ts"}' }] });
    const request = adapter.nextRequest([
      { callId: "read-1", name: "workspace.read", content: "collected source evidence" },
    ], { finalizationRequired: true }).body as Record<string, unknown>;
    const input = request.input as Array<Record<string, unknown>>;
    const expectedOutput = [{ type: "function_call_output", call_id: "read-1", output: "collected source evidence" }];
    if (resultArtifactContract === "portable-stage-json-v1") {
      assert.deepEqual(input.slice(-2), [...expectedOutput, { role: "user", content: AGENT_PORTABLE_FINALIZATION_REMINDER }]);
    } else {
      assert.deepEqual(input.slice(-1), expectedOutput);
      assert.equal(input.some((item) => item.content === AGENT_PORTABLE_FINALIZATION_REMINDER), false);
    }
    const retry = adapter.nextRequest([], { finalizationRequired: true, artifactRepairReminder: true }).body as Record<string, unknown>;
    const retryInput = retry.input as Array<Record<string, unknown>>;
    if (resultArtifactContract === "portable-stage-json-v1") {
      assert.deepEqual(retryInput.slice(-2), [
        { role: "user", content: AGENT_ARTIFACT_REPAIR_REMINDER },
        { role: "user", content: AGENT_PORTABLE_FINALIZATION_REMINDER },
      ]);
    }
  }
});
