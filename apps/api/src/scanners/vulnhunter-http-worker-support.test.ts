import assert from "node:assert/strict";
import test from "node:test";

import { SecretRedactor } from "../redaction.js";
import {
  addVulnHunterHttpUsage,
  advanceVulnHunterHttpTerminal,
  serializeVulnHunterHttpEvent,
  vulnHunterHttpTerminalExitCode,
} from "./vulnhunter-http-worker-support.js";

test("HTTP VulnHunter telemetry redacts provider credentials and endpoints before JSONL persistence", () => {
  const redactor = new SecretRedactor();
  const apiKey = "secret-api-key-12345";
  const baseUrl = "https://private-provider.example.invalid/v1";
  const header = "custom-header-secret-67890";
  const oauthToken = "private-xai-oauth-token";
  redactor.register("test", [apiKey, baseUrl, header, oauthToken]);

  const line = serializeVulnHunterHttpEvent({
    type: "completion",
    text: `${apiKey} ${baseUrl} ${header} ${oauthToken}`,
    structured: { authorization: `Bearer ${oauthToken}` },
  }, redactor.redactText.bind(redactor));

  assert.equal(line.includes(apiKey), false);
  assert.equal(line.includes(baseUrl), false);
  assert.equal(line.includes(header), false);
  assert.equal(line.includes(oauthToken), false);
  assert.match(line, /\[REDACTED\]/);
});

test("HTTP VulnHunter preserves unknown versus reported-zero usage for pricing", () => {
  const initial = {
    reported: false,
    inputTokensKnown: false,
    cachedInputTokensKnown: false,
    cacheWriteInputTokensKnown: false,
    outputTokensKnown: false,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
  };
  const first = addVulnHunterHttpUsage(initial, {
    inputTokens: 100,
    cachedInputTokens: 40,
    cacheWriteInputTokens: 0,
    outputTokens: 20,
    reasoningTokens: null,
  });
  assert.equal(first.inputTokensKnown, true);
  assert.equal(first.cachedInputTokensKnown, true);
  assert.equal(first.cacheWriteInputTokensKnown, true);
  assert.equal(first.outputTokensKnown, true);

  const second = addVulnHunterHttpUsage(first, {
    inputTokens: 50,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    outputTokens: 10,
    reasoningTokens: null,
  });
  assert.equal(second.inputTokens, 150);
  assert.equal(second.inputTokensKnown, true);
  assert.equal(second.cachedInputTokensKnown, false);
  assert.equal(second.cacheWriteInputTokensKnown, false);
  assert.equal(second.outputTokensKnown, true);
});

test("HTTP VulnHunter keeps a tool-path failure failed after provider cleanup cancellation", () => {
  let terminal = advanceVulnHunterHttpTerminal("running", {
    type: "failure",
    code: "tool_path_denied",
  });
  terminal = advanceVulnHunterHttpTerminal(terminal, { type: "cancellation", remote: true });

  assert.equal(terminal, "failed");
  assert.equal(vulnHunterHttpTerminalExitCode(terminal), 1);

  const userAbort = advanceVulnHunterHttpTerminal("running", {
    type: "cancellation",
    remote: true,
  });
  assert.equal(userAbort, "cancelled");
  assert.equal(vulnHunterHttpTerminalExitCode(userAbort), 143);
});
