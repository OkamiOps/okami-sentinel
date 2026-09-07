import assert from "node:assert/strict";
import test from "node:test";

import { parseStructuredResult } from "./structured-result.js";

test("accepts one fenced JSON object surrounded by provider prose", () => {
  const text = [
    "Inventory artifact written. Below is the structured completion.",
    "```json",
    JSON.stringify({
      stage: "inventory",
      artifact: "01-inventory.json",
      status: "completed",
      summary: "Inventory completed.",
    }),
    "```",
  ].join("\n");

  assert.deepEqual(parseStructuredResult(undefined, text), {
    stage: "inventory",
    artifact: "01-inventory.json",
    status: "completed",
    summary: "Inventory completed.",
  });
});

test("rejects ambiguous responses with multiple fenced JSON values", () => {
  const text = [
    "```json",
    '{"status":"draft"}',
    "```",
    "```json",
    '{"status":"completed"}',
    "```",
  ].join("\n");

  assert.equal(parseStructuredResult(undefined, text), null);
});

test("keeps invalid and scalar fenced values unstructured", () => {
  assert.equal(parseStructuredResult(undefined, "Result:\n```json\nnot-json\n```"), null);
  assert.equal(parseStructuredResult(undefined, "Result:\n```json\ntrue\n```"), null);
});


test("rejection diagnostics classify malformed JSON without exposing provider content", () => {
  for (const [content, expected] of [
    ['{"private-value":', "syntax"],
    ['"private-value"', "non-structured"],
    ['```json\n{}\n```\n```json\n{}\n```', "ambiguous-fences"],
    ['```json\n{"private-value":\n```', "syntax"],
  ] as const) {
    let diagnostic: string | undefined;
    assert.equal(parseStructuredResult(undefined, content, (reason) => { diagnostic = reason; }), null);
    assert.equal(diagnostic, expected);
    assert.ok(!diagnostic?.includes("private-value"));
  }
});
