import assert from "node:assert/strict";
import test from "node:test";
import { createScanResumeApp } from "./scan-resume-api.js";
import { assertBudgetResumeCap } from "./scanners/portable-budget-partial.js";
import { matchPolicy } from "./auth/route-policy.js";

test("resume is administrator-only, like starting a scan", () => {
  assert.equal(matchPolicy("POST", "/scans/source/resume")?.requirement.kind, "admin");
});

for (const cap of [undefined, 300, 100]) {
  test(`resume endpoint validates cap and returns new scan: ${cap}`, async () => {
    const app = createScanResumeApp({ async resume(id, maxCostUsd) {
      assert.equal(id, "source");
      assert.equal(maxCostUsd, cap);
      assertBudgetResumeCap({ spentUsd: 150, maxCostUsd: 200 } as Parameters<typeof assertBudgetResumeCap>[0], maxCostUsd ?? 400);
      return "resumed";
    } });
    const response = await app.request("/scans/source/resume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxCostUsd: cap }) });
    assert.equal(response.status, cap === 100 ? 422 : 201);
    assert.deepEqual(await response.json(), cap === 100 ? { code: "resume_budget_cap_must_exceed_prior_spend_and_cap", error: "resume budget cap must exceed prior spend and cap" } : { scanId: "resumed" });
  });
}

for (const [code, status] of [["resume_requires_checkpoint", 422], ["resume_scan_not_found", 404], ["scan_capacity_full", 409], ["unexpected", 500]] as const) {
  test(`resume endpoint maps ${code}`, async () => {
    const app = createScanResumeApp({ async resume() { throw new Error(code); } });
    const response = await app.request("/scans/source/resume", { method: "POST", body: "{}" });
    assert.equal(response.status, status);
    assert.equal((await response.json()).code, code === "unexpected" ? "resume_failed" : code);
  });
}

for (const body of ["", "null", "[]", '{"maxCostUsd":"300"}', '{"maxCostUsd":0}']) {
  test(`resume endpoint rejects invalid body ${body}`, async () => {
    const app = createScanResumeApp({ async resume() { assert.fail("must not resume"); } });
    assert.equal((await app.request("/scans/source/resume", { method: "POST", body })).status, 400);
  });
}
