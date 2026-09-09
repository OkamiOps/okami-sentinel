import assert from "node:assert/strict";
import test from "node:test";
import { createConstrainedWireSession, AgentSessionError, type AgentToolCall, type AgentToolResult,
  type AgentWireRequestControl, type NormalizedModelReply, type WorkspaceToolHost } from "./session-types.js";

const limits = { maxModelTurns: 16, maxToolCalls: 20, maxInputBytes: 1_048_576, maxOutputBytes: 65_536, timeoutMs: 0 };
const call = (id: string, name: AgentToolCall["name"], input = {}): AgentToolCall => ({ id, name, input });
const write = (id: string, content: string) => call(id, "results.write", { path: "report.json", content });
const reply = (toolCalls: AgentToolCall[], padding = "") => ({ toolCalls, padding });
function adapter(controls: Array<AgentWireRequestControl | undefined>, consumed: AgentToolResult[][]) {
  return {
    nextRequest(results: readonly AgentToolResult[], control?: AgentWireRequestControl) {
      controls.push(control); consumed.push([...results]);
      return { operation: "responses" as const, body: {} };
    },
    readResponse(value: unknown): NormalizedModelReply {
      return { toolCalls: (value as { toolCalls: AgentToolCall[] }).toolCalls, text: null, structured: null, usage: null };
    },
  };
}

test("artifact byte reserve stops later tools in the same reply before I/O and leaves room for JSON repair", async () => {
  const controls: Array<AgentWireRequestControl | undefined> = [], consumed: AgentToolResult[][] = [];
  const executed: string[] = [], budgets: number[] = [];
  const frames = [reply([call("list", "workspace.list"), call("read", "workspace.read"), call("search", "workspace.search")], "x".repeat(42_000)),
    reply([write("broken", "{broken")], "y".repeat(2_000)), reply([write("valid", '{"ok":true}')], "z".repeat(2_000))];
  const host: WorkspaceToolHost = {
    minimumOutputBytes(name) { return name === "workspace.list" ? 1 : name === "results.write" ? 30 : 4_000; },
    async call(name, input, budget) {
      executed.push(name); budgets.push(budget!.maxOutputBytes);
      if (name === "workspace.list") return { content: "x".repeat(6_000) };
      assert.equal(name, "results.write");
      assert.equal(JSON.parse((input as { content: string }).content).ok, true);
      return { content: '{"path":"report.json","bytes":12}', artifact: { path: "report.json", bytes: 12 } };
    },
  };
  const session = createConstrainedWireSession({ limits, signal: new AbortController().signal, terminalMode: "artifact-write", host,
    upstream: { async request() { return frames.shift(); } }, adapter: adapter(controls, consumed) });
  const events = [];
  for await (const event of session.run()) events.push(event);
  assert.deepEqual(executed, ["workspace.list", "results.write"]);
  assert.ok(budgets[0]! < limits.maxOutputBytes - 42_000 - 16_384);
  assert.equal(controls[0], undefined);
  assert.equal(controls[1]?.finalizationRequired, true);
  assert.equal(controls[2], undefined, "existing bounded repair inspection allowance is preserved");
  assert.match(consumed[1]![1]!.content, /finalization_required/);
  assert.match(consumed[1]![2]!.content, /finalization_required/);
  assert.match(consumed[2]![0]!.content, /json-invalid/);
  assert.equal(events.filter(e => e.type === "artifact").length, 1);
});

test("artifact reserve caps actual tool output and closes exploration after a bounded host rejection", async () => {
  const controls: Array<AgentWireRequestControl | undefined> = [], consumed: AgentToolResult[][] = [];
  const frames = [reply([call("large", "workspace.read")], "x".repeat(40_000)), reply([write("valid", '{"ok":true}')])];
  const session = createConstrainedWireSession({ limits, signal: new AbortController().signal, terminalMode: "artifact-write",
    host: { minimumOutputBytes() { return 1; }, async call(name, _input, budget) {
      if (name === "workspace.read") {
        assert.ok(budget!.maxOutputBytes < 10_000);
        throw new AgentSessionError("tool_output_limit");
      }
      return { content: "{}", artifact: { path: "report.json", bytes: 12 } };
    } }, upstream: { async request() { return frames.shift(); } }, adapter: adapter(controls, consumed) });
  for await (const _ of session.run()) { /* consume */ }
  assert.equal(controls[1]?.finalizationRequired, true);
});

test("reserve never raises the hard limit on an oversized provider response", async () => {
  let calls = 0;
  const session = createConstrainedWireSession({ limits, signal: new AbortController().signal, terminalMode: "artifact-write",
    host: { minimumOutputBytes() { return 1; }, async call() { calls++; return { content: "{}" }; } },
    upstream: { async request() { return reply([write("valid", '{"ok":true}')], "x".repeat(limits.maxOutputBytes)); } },
    adapter: adapter([], []) });
  await assert.rejects(async () => { for await (const _ of session.run()) { /* consume */ } }, { code: "agent_output_byte_limit" });
  assert.equal(calls, 0);
});

test("provider-completion sessions retain the full tool byte budget", async () => {
  const first = reply([call("read", "workspace.read")], "x".repeat(40_000));
  const frames = [first, reply([])];
  const session = createConstrainedWireSession({ limits, signal: new AbortController().signal, terminalMode: "provider-completion",
    host: { minimumOutputBytes() { return 1; }, async call(_name, _input, budget) {
      assert.equal(budget!.maxOutputBytes, limits.maxOutputBytes - Buffer.byteLength(JSON.stringify(first)));
      return { content: "ok" };
    } }, upstream: { async request() { return frames.shift(); } }, adapter: adapter([], []) });
  for await (const _ of session.run()) { /* consume */ }
});
