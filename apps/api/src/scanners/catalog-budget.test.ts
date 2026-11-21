import assert from "node:assert/strict";
import test from "node:test";
import { validateScannerRequest } from "./catalog.js";

for (const [engine, name] of [["mantis", "Google Mantis"], ["vulnhunter", "Capital One VulnHunter"]] as const) {
  test(`${name} rejects a USD cap with an actionable plan-usage explanation`, async () => {
    const request = {
      repositoryPath: "/workspace/repository", engine,
      connection: { connectionId: "connection-a", modelSelectionMode: "runtime-default" as const, modelId: null },
    };
    await assert.rejects(validateScannerRequest({ ...request, maxCostUsd: 1 }), {
      message: `${name} não consegue aplicar um teto em USD por scan: a execução usa o consumo do plano. Escolha Codex Security para usar um teto ou marque explicitamente "Sem teto em USD" para este scan (omita maxCostUsd).`,
    });
    assert.equal((await validateScannerRequest(request)).engine, engine);
  });
}
