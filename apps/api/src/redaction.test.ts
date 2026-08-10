import assert from "node:assert/strict";
import test from "node:test";
import {
  SecretRedactor,
  processSecretValues,
  redactErrorMessage,
} from "./redaction.js";

test("redacts registered values and credential-shaped text", () => {
  const redactor = new SecretRedactor();
  redactor.register("connection/one", ["sk-live-abc123", "https://secret.example/v1"]);
  const output = redactor.redactText(
    "Authorization: Bearer sk-live-abc123 X-Api-Key=sk-live-abc123 " +
      "url=https://secret.example/v1?api_key=sk-live-abc123",
  );
  assert.equal(output.includes("sk-live-abc123"), false);
  assert.equal(output.includes("secret.example"), false);
  assert.match(output, /\[REDACTED\]/);
});

test("unregister removes only the requested scope", () => {
  const redactor = new SecretRedactor();
  redactor.register("one", ["same-secret"]);
  redactor.register("two", ["same-secret", "second-secret"]);
  redactor.unregister("one");
  assert.equal(redactor.redactText("same-secret second-secret"), "[REDACTED] [REDACTED]");
});

test("safe errors do not echo arbitrary payloads", () => {
  assert.equal(
    redactErrorMessage(new Error("request failed Authorization: Bearer sk-leak")),
    "request failed Authorization: [REDACTED]",
  );
});

test("worker environment discovery returns only sensitive names", () => {
  assert.deepEqual(
    processSecretValues({ NORMAL: "visible", XAI_API_KEY: "xai-secret", ACCESS_TOKEN: "token-value" }),
    ["xai-secret", "token-value"],
  );
});
