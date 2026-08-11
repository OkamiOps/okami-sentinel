import fs from "node:fs";

import { getProviderRuntime } from "../provider-runtime.js";
import { globalSecretRedactor, redactErrorMessage } from "../redaction.js";
import {
  runMantisHttpAgent,
  type MantisHttpWorkerConfiguration,
} from "./mantis-http-runner.js";

const controller = new AbortController();

process.on("SIGTERM", () => controller.abort());
process.on("SIGINT", () => controller.abort());

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("Usage: mantis-http-worker <config.json>");
  const configuration = JSON.parse(fs.readFileSync(configPath, "utf8")) as MantisHttpWorkerConfiguration;
  const runtime = getProviderRuntime();
  await runMantisHttpAgent(configuration, {
    getSnapshot: (scanId) => runtime.store.getSnapshot(scanId),
    getConnection: (connectionId) => runtime.store.get(connectionId),
    getModel: (connectionId, modelId) => runtime.store.getModel(connectionId, modelId),
    getLatestCapabilityCheck: (connectionId, modelId, protocol) =>
      runtime.store.getLatestCapabilityCheck(connectionId, modelId, protocol),
    vault: runtime.vault,
    xaiOAuth: runtime.xaiOAuthTokenResolver,
    signal: controller.signal,
    redactor: globalSecretRedactor,
    log: (line) => process.stdout.write(`${globalSecretRedactor.redactText(line)}\n`),
  });
}

void main().catch((error) => {
  process.stderr.write(`[mantis-http] ${redactErrorMessage(error)}\n`);
  process.exitCode = controller.signal.aborted ? 143 : 1;
});
