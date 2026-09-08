#!/usr/bin/env node
/**
 * Deterministic OpenAI-chat fixture for Docker QA only.
 *
 * Run it from a read-only QA bind mount in a disposable container; it is not
 * copied into the production runtime image:
 *   node /qa/test-provider.mjs --port 8788
 *
 * It binds loopback only and implements the exact bounded tool loop exercised
 * by the real custom-openai-compatible connection: discover -> capability
 * probe -> scanner artifact. It has no access to the application vault or to
 * a repository. The fixture finding intentionally references src/auth.ts so
 * the QA repository must contain that file with at least one line.
 */
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 8788;
const DEFAULT_SLOW_MS = 60_000;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

let callSequence = 0;

export function parseArguments(argv, environment = process.env) {
  let port = portFromEnvironment(environment.CSB_TEST_PROVIDER_PORT, DEFAULT_PORT);
  let slowMs = durationFromEnvironment(environment.CSB_TEST_PROVIDER_SLOW_MS, DEFAULT_SLOW_MS);
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") {
      help = true;
      continue;
    }
    if (value === "--port" || value === "--slow-ms") {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`missing value for ${value}`);
      index += 1;
      if (value === "--port") port = parsePort(next, "--port");
      else slowMs = parseDuration(next, "--slow-ms");
      continue;
    }
    if (value.startsWith("--port=")) {
      port = parsePort(value.slice("--port=".length), "--port");
      continue;
    }
    if (value.startsWith("--slow-ms=")) {
      slowMs = parseDuration(value.slice("--slow-ms=".length), "--slow-ms");
      continue;
    }
    throw new Error(`unknown argument: ${value}`);
  }
  return { host: HOST, port, slowMs, help };
}

export function helpText() {
  return [
    "Usage: node scripts/docker/test-provider.mjs [options]",
    "",
    "Loopback-only deterministic OpenAI-compatible provider for Docker QA.",
    "It exposes GET /v1/models and POST /v1/chat/completions.",
    "",
    "Options:",
    "  --port <number>     Loopback port (default: CSB_TEST_PROVIDER_PORT or 8788)",
    "  --slow-ms <number>  Delay for docker-fixture-slow (default: 60000)",
  ].join("\n");
}

export function createTestProvider({ slowMs = DEFAULT_SLOW_MS } = {}) {
  const delay = parseDuration(slowMs, "slowMs");
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${HOST}`);
      if (request.method === "GET" && url.pathname === "/v1/models") {
        respondJson(response, 200, modelsResponse());
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = await readJsonBody(request);
        if (body.model === "docker-fixture-slow" && !systemInstruction(body).includes("bounded Sentinel capability probe")) {
          delayUntilClosedOrElapsed(request, response, delay, () => {
            respondJson(response, 200, chatReply(body, finalMessage()));
          });
          return;
        }
        respondJson(response, 200, chatReply(body, nextMessage(body)));
        return;
      }
      respondJson(response, request.method === "GET" || request.method === "POST" ? 404 : 405, {
        error: { message: "fixture route not found", type: "invalid_request_error" },
      });
    } catch (error) {
      const message = error instanceof RequestError ? error.message : "invalid JSON request";
      respondJson(response, error instanceof RequestError ? error.status : 400, {
        error: { message, type: "invalid_request_error" },
      });
    }
  });
}

export async function listenTestProvider(options = {}) {
  const host = options.host ?? HOST;
  if (host !== HOST) throw new Error("test provider must bind 127.0.0.1 only");
  const port = parsePort(options.port ?? DEFAULT_PORT, "port");
  const server = createTestProvider({ slowMs: options.slowMs ?? DEFAULT_SLOW_MS });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

function modelsResponse() {
  return {
    object: "list",
    data: [
      { id: "docker-fixture", object: "model", created: 0, owned_by: "docker-qa" },
      { id: "docker-fixture-slow", object: "model", created: 0, owned_by: "docker-qa" },
    ],
  };
}

function nextMessage(body) {
  if (isJsonFinalization(body)) return finalMessage();
  if (!hasToolResult(body)) return toolMessage("workspace_list", { path: ".", maxDepth: 2, maxEntries: 32 });
  return toolMessage("results_write", writeArguments(body));
}

function writeArguments(body) {
  const system = systemInstruction(body);
  const resultTool = resultWriteTool(body);
  const portablePath = enumPath(resultTool);
  if (portablePath !== null) {
    return {
      path: portablePath,
      content: portableArtifact(portablePath, portableReportIsSharded(resultTool)),
    };
  }
  const mantisStage = system.match(/\bstage_id=([a-z-]+)/)?.[1];
  if (system.includes("Sentinel Mantis authorized defensive static-analysis stage.") && mantisStage !== undefined) {
    return {
      path: `${mantisStage}.json`,
      content: JSON.stringify(mantisStage === "report" ? mantisReport() : {
        stage: mantisStage,
        summary: `Deterministic Docker QA state for ${mantisStage}.`,
      }),
    };
  }
  if (system.includes("bounded Sentinel capability probe")) {
    return { path: "probe.json", content: JSON.stringify({ ok: true, fixture: "docker" }) };
  }
  if (system.includes("VulnHunter") || system.includes("sentinel-findings.json")) {
    return { path: "sentinel-findings.json", content: JSON.stringify(vulnHunterReport()) };
  }
  // Keep an unknown caller on the ordinary capability-probe path. This is
  // deliberately not an alternate scanner result or a bypass around the API.
  return { path: "probe.json", content: JSON.stringify({ ok: true, fixture: "docker" }) };
}

function portableArtifact(path, reportIsSharded) {
  const anchor = fixtureAnchor(false);
  switch (path) {
    case "01-inventory.json":
      return stageArtifact("inventory", { inspected: ["."], unexamined: [] });
    case "02-threat-model.json":
      return stageArtifact("threat-model", { inspected: ["."], unexamined: [] });
    case "03-discovery.json":
      return {
        ...stageArtifact("discovery", { inspected: ["src/auth.ts"], unexamined: [] }),
        candidates: [{ id: "fixture-authz-missing", category: "authorization", anchors: [anchor] }],
      };
    case "04-dataflow.json":
      return assessmentArtifact("dataflow", anchor);
    case "05-validation.json":
      return assessmentArtifact("validation", anchor);
    case "sentinel-findings.json":
      return portableReport(anchor, reportIsSharded);
    default:
      throw new RequestError(400, "unsupported portable artifact path");
  }
}

function stageArtifact(stage, scope) {
  return {
    schemaVersion: 1,
    stage,
    summary: `Deterministic Docker QA ${stage} stage completed.`,
    observations: [],
    scope,
  };
}

function assessmentArtifact(stage, anchor) {
  return {
    schemaVersion: 1,
    stage,
    summary: `Deterministic Docker QA ${stage} assessment completed.`,
    observations: [],
    assessments: [{
      candidateId: "fixture-authz-missing",
      status: "confirmed",
      reason: "untrusted-flow-reaches-sink",
      evidence: [anchor],
    }],
  };
}

function portableReport(anchor, shardOnly) {
  const report = {
    schemaVersion: 1,
    stage: "report",
    findings: [{
      id: "fixture-authz-missing",
      candidateId: "fixture-authz-missing",
      title: "Fixture authorization check is intentionally absent",
      severity: "high",
      confidence: "high",
      category: "authorization",
      summary: "The deterministic Docker fixture marks this source location as a known authorization review finding.",
      rootCause: "The fixture represents a handler path without an ownership predicate before returning protected data.",
      impact: "An authenticated caller could access another account record when the missing ownership check is reachable.",
      remediation: "Require an ownership predicate that binds the requested account to the authenticated principal before returning data.",
      anchors: [fixtureAnchor(true)],
      cwe: ["CWE-862"],
      severityRationale: "The fixture uses high severity to exercise the report pipeline with an evidence-backed authorization finding.",
    }],
  };
  if (shardOnly) return report;
  return {
    ...report,
    coverage: {
      inspected: [".", "src/auth.ts"],
      unexamined: [],
      candidates: [{
        candidateId: "fixture-authz-missing",
        disposition: "reported",
        reason: "untrusted-flow-reaches-sink",
        evidence: [anchor],
      }],
    },
  };
}

function mantisReport() {
  return {
    schemaVersion: 1,
    engine: "mantis",
    stage: "report",
    findings: [{
      id: "fixture-authz-missing",
      title: "Fixture authorization check is intentionally absent",
      severity: "HIGH",
      remediation: "Require an ownership predicate before returning protected account data.",
      code_paths: ["src/auth.ts:1"],
    }],
  };
}

function vulnHunterReport() {
  return {
    schemaVersion: 1,
    findings: [{
      id: "fixture-authz-missing",
      title: "Fixture authorization check is intentionally absent",
      severity: "high",
      confidence: "high",
      cwe: ["CWE-862"],
      summary: "The deterministic Docker fixture supplies one known authorization finding for an end-to-end report check.",
      rootCause: "The fixture represents a handler that returns protected data before an ownership predicate is applied.",
      entryPoint: "The fixture request handler represented in src/auth.ts receives an authenticated account lookup.",
      dataFlow: "A caller-controlled account identifier reaches the protected lookup without a matching ownership guard.",
      impact: "An authenticated caller could access data associated with another account when this fixture route is reachable.",
      remediation: "Require an ownership predicate that binds the requested account to the authenticated principal before returning data.",
      severityRationale: "High severity exercises the durable report path for an authorization failure with a direct protected-data impact.",
      validation: {
        summary: "Static fixture validation only; no request, payload, exploit, or runtime operation was performed.",
        limitations: ["The deterministic provider validates the wire contract only and does not execute application code."],
      },
      evidence: [fixtureAnchor(true)],
    }],
  };
}

function fixtureAnchor(withExplanation) {
  return {
    path: "src/auth.ts",
    startLine: 1,
    endLine: 1,
    role: "sink",
    ...(withExplanation
      ? { explanation: "Fixture source anchor for the deterministic authorization finding used by Docker QA." }
      : {}),
  };
}

function finalMessage() {
  return { content: JSON.stringify({ ok: true, fixture: "docker" }) };
}

function toolMessage(name, arguments_) {
  callSequence += 1;
  return {
    tool_calls: [{
      id: `docker-fixture-call-${callSequence}`,
      type: "function",
      function: { name, arguments: JSON.stringify(arguments_) },
    }],
  };
}

function chatReply(body, message) {
  const hasCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  return {
    id: `chatcmpl-docker-fixture-${callSequence}`,
    object: "chat.completion",
    created: 0,
    model: typeof body.model === "string" ? body.model : "docker-fixture",
    choices: [{ index: 0, message, finish_reason: hasCalls ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function resultWriteTool(body) {
  if (!Array.isArray(body.tools)) return null;
  return body.tools.find((candidate) => isRecord(candidate) && isRecord(candidate.function) &&
    candidate.function.name === "results_write") ?? null;
}

function enumPath(tool) {
  const parameters = isRecord(tool?.function) && isRecord(tool.function.parameters)
    ? tool.function.parameters : null;
  const properties = isRecord(parameters?.properties) ? parameters.properties : null;
  const path = isRecord(properties?.path) ? properties.path : null;
  return Array.isArray(path?.enum) && path.enum.length === 1 && typeof path.enum[0] === "string"
    ? path.enum[0]
    : null;
}

function portableReportIsSharded(tool) {
  const parameters = isRecord(tool?.function) && isRecord(tool.function.parameters)
    ? tool.function.parameters : null;
  const properties = isRecord(parameters?.properties) ? parameters.properties : null;
  const content = isRecord(properties?.content) ? properties.content : null;
  const contentProperties = isRecord(content?.properties) ? content.properties : null;
  return contentProperties !== null && contentProperties.coverage === undefined;
}

function hasToolResult(body) {
  return Array.isArray(body.messages) && body.messages.some((message) => isRecord(message) && message.role === "tool");
}

function isJsonFinalization(body) {
  return isRecord(body.response_format) && body.response_format.type === "json_object";
}

function systemInstruction(body) {
  if (!Array.isArray(body.messages)) return "";
  return body.messages
    .filter((message) => isRecord(message) && message.role === "system")
    .map((message) => contentText(message.content))
    .join("\n");
}

function contentText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "").join("");
}

function delayUntilClosedOrElapsed(request, response, delay, callback) {
  let settled = false;
  const cleanup = () => {
    request.off("aborted", close);
    response.off("close", close);
  };
  const close = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    cleanup();
  };
  const timer = setTimeout(() => {
    if (settled || response.destroyed) return;
    settled = true;
    cleanup();
    callback();
  }, delay);
  request.once("aborted", close);
  response.once("close", close);
}

function respondJson(response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new RequestError(413, "request body exceeds fixture limit");
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError(400, "request body must be JSON");
  }
  if (!isRecord(value)) throw new RequestError(400, "request body must be a JSON object");
  return value;
}

function portFromEnvironment(value, fallback) {
  return value === undefined ? fallback : parsePort(value, "CSB_TEST_PROVIDER_PORT");
}

function durationFromEnvironment(value, fallback) {
  return value === undefined ? fallback : parseDuration(value, "CSB_TEST_PROVIDER_SLOW_MS");
}

function parsePort(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 65_535) {
    throw new Error(`${label} must be an integer from 0 to 65535`);
  }
  return number;
}

function parseDuration(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 10 * 60_000) {
    throw new Error(`${label} must be an integer from 1 to 600000`);
  }
  return number;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(helpText());
    return;
  }
  const server = await listenTestProvider(options);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("could not resolve test provider address");
  console.log(`Docker QA fixture provider listening on http://${HOST}:${address.port}`);
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
