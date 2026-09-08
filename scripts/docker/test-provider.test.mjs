import assert from "node:assert/strict";
import test from "node:test";

import { listenTestProvider, parseArguments } from "./test-provider.mjs";

let server;
let baseUrl;

test.before(async () => {
  server = await listenTestProvider({ port: 0, slowMs: 250 });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("argument parsing keeps the fixture loopback-only and configurable", () => {
  assert.deepEqual(parseArguments(["--port", "0", "--slow-ms=123"]), {
    host: "127.0.0.1",
    port: 0,
    slowMs: 123,
    help: false,
  });
  assert.throws(() => parseArguments(["--port", "-1"]), /integer from 0 to 65535/);
});

test("models discovery and the real three-turn capability probe are deterministic", async () => {
  const models = await fetchJson("/v1/models");
  assert.deepEqual(models.data.map((model) => model.id), ["docker-fixture", "docker-fixture-slow"]);

  const initial = probeBody();
  const first = await completion(initial);
  assert.equal(toolName(first), "workspace_list");

  const afterList = withToolResult(initial, first, { entries: [], truncated: false });
  const second = await completion(afterList);
  assert.equal(toolName(second), "results_write");
  assert.deepEqual(toolArguments(second), { path: "probe.json", content: "{\"ok\":true,\"fixture\":\"docker\"}" });

  const final = await completion({
    ...withToolResult(afterList, second, { path: "probe.json", bytes: 30 }),
    response_format: { type: "json_object" },
  });
  assert.deepEqual(JSON.parse(final.choices[0].message.content), { ok: true, fixture: "docker" });
});

test("Portable Codex six stages receive valid object artifacts and the fixture finding", async () => {
  const paths = [
    "01-inventory.json",
    "02-threat-model.json",
    "03-discovery.json",
    "04-dataflow.json",
    "05-validation.json",
    "sentinel-findings.json",
  ];
  for (const path of paths) {
    const initial = portableBody(path);
    const first = await completion(initial);
    assert.equal(toolName(first), "workspace_list", path);
    const second = await completion(withToolResult(initial, first, { entries: [], truncated: false }));
    assert.equal(toolName(second), "results_write", path);
    const arguments_ = toolArguments(second);
    assert.equal(arguments_.path, path);
    assert.equal(typeof arguments_.content, "object");
    assert.equal(arguments_.content.schemaVersion, 1);
    if (path === "sentinel-findings.json") {
      assert.equal(arguments_.content.findings[0].anchors[0].path, "src/auth.ts");
    }
  }
});

test("Mantis stages and VulnHunter receive their exact report artifacts", async () => {
  for (const stage of ["architecture", "report"]) {
    const initial = mantisBody(stage);
    const first = await completion(initial);
    const second = await completion(withToolResult(initial, first, { entries: [], truncated: false }));
    const arguments_ = toolArguments(second);
    assert.equal(arguments_.path, `${stage}.json`);
    const content = JSON.parse(arguments_.content);
    assert.equal(stage === "report" ? content.findings[0].code_paths[0] : content.stage, stage === "report" ? "src/auth.ts:1" : stage);
  }

  const initial = vulnHunterBody();
  const first = await completion(initial);
  const second = await completion(withToolResult(initial, first, { entries: [], truncated: false }));
  const arguments_ = toolArguments(second);
  assert.equal(arguments_.path, "sentinel-findings.json");
  assert.equal(JSON.parse(arguments_.content).findings[0].evidence[0].path, "src/auth.ts");
});

test("slow model stops work when the client closes the request", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20);
  try {
    await assert.rejects(fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "docker-fixture-slow", messages: [] }),
      signal: controller.signal,
    }), (error) => error?.name === "AbortError");
  } finally {
    clearTimeout(timer);
  }
  const models = await fetchJson("/v1/models");
  assert.equal(models.data[0].id, "docker-fixture");
});

async function fetchJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  assert.equal(response.status, 200);
  return response.json();
}

async function completion(body) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return response.json();
}

function probeBody() {
  return {
    model: "docker-fixture",
    messages: [{
      role: "system",
      content: "This is a bounded Sentinel capability probe. First use workspace_list. Then use results_write with path probe.json. Finally return a JSON object as the completion.",
    }],
    tools: workspaceTools(),
    tool_choice: "required",
  };
}

function portableBody(path) {
  const write = workspaceTools().at(-1);
  write.function.parameters.properties.path = { type: "string", enum: [path] };
  write.function.parameters.properties.content = { type: "object", properties: {} };
  return {
    model: "docker-fixture",
    messages: [{ role: "system", content: "Sentinel Portable Codex fixture stage." }],
    tools: workspaceToolsWithWrite(write),
    tool_choice: "required",
  };
}

function mantisBody(stage) {
  return {
    model: "docker-fixture",
    messages: [{
      role: "system",
      content: `Sentinel Mantis authorized defensive static-analysis stage.\nstage_id=${stage}\nWrite exactly one compact JSON artifact with results_write at the result-relative path ${stage}.json.`,
    }],
    tools: workspaceTools(),
    tool_choice: "required",
  };
}

function vulnHunterBody() {
  return {
    model: "docker-fixture",
    messages: [{
      role: "system",
      content: "Perform one defensive static review using Sentinel's audited VulnHunter methodology profile. After consuming repository evidence use results_write with the fixed result-relative path sentinel-findings.json.",
    }],
    tools: workspaceTools(),
    tool_choice: "required",
  };
}

function workspaceTools() {
  return workspaceToolsWithWrite({
    type: "function",
    function: {
      name: "results_write",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
    },
  });
}

function workspaceToolsWithWrite(write) {
  return [
    { type: "function", function: { name: "workspace_list", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "workspace_read", parameters: { type: "object", properties: {} } } },
    write,
  ];
}

function withToolResult(body, reply, result) {
  const call = reply.choices[0].message.tool_calls[0];
  return {
    ...body,
    messages: [
      ...body.messages,
      { role: "assistant", content: null, tool_calls: reply.choices[0].message.tool_calls },
      { role: "tool", tool_call_id: call.id, content: JSON.stringify(result) },
    ],
  };
}

function toolName(reply) {
  return reply.choices[0].message.tool_calls[0].function.name;
}

function toolArguments(reply) {
  return JSON.parse(reply.choices[0].message.tool_calls[0].function.arguments);
}
