import assert from "node:assert/strict";
import test from "node:test";

import { SecretRedactor } from "../redaction.js";
import { serializeVulnHunterHttpEvent } from "./vulnhunter-http-worker-support.js";

test("HTTP VulnHunter telemetry redacts provider credentials and endpoints before JSONL persistence", () => {
  const redactor = new SecretRedactor();
  const apiKey = "secret-api-key-12345";
  const baseUrl = "https://private-provider.example.invalid/v1";
  const header = "custom-header-secret-67890";
  redactor.register("test", [apiKey, baseUrl, header]);

  const line = serializeVulnHunterHttpEvent({
    type: "completion",
    text: `${apiKey} ${baseUrl} ${header}`,
    structured: { authorization: `Bearer ${apiKey}` },
  }, redactor.redactText.bind(redactor));

  assert.equal(line.includes(apiKey), false);
  assert.equal(line.includes(baseUrl), false);
  assert.equal(line.includes(header), false);
  assert.match(line, /\[REDACTED\]/);
});
