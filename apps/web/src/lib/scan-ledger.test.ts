import assert from "node:assert/strict";
import test from "node:test";

import { scanLedgerIdentity } from "./scan-ledger";

test("presents engine, model, High+ and total as first-class ledger identity", () => {
  assert.deepEqual(
    scanLedgerIdentity({
      engine: "mantis",
      model: "MiniMax-M3",
      severity: {
        critical: 2,
        high: 3,
        medium: 8,
        low: 5,
        info: 0,
        unknown: 0,
        total: 18,
      },
    }),
    {
      engine: "Google Mantis",
      model: "MiniMax-M3",
      highPlus: 5,
      total: 18,
    },
  );
});

test("uses stable product names for every scanner engine", () => {
  const severity = { critical: 0, high: 0, medium: 0, low: 0, info: 0, unknown: 0, total: 0 };
  assert.equal(scanLedgerIdentity({ engine: "codex-security", model: null, severity }).engine, "Codex Security");
  assert.equal(scanLedgerIdentity({ engine: "vulnhunter", model: "grok-4.5", severity }).engine, "Capital One VulnHunter");
  assert.equal(scanLedgerIdentity({ engine: "codex-security", model: null, severity }).model, "Provider default");
});
