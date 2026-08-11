import fs from "node:fs";

import { getProviderRuntime } from "../provider-runtime.js";
import {
  runMantisLocalClaude,
  type MantisLocalWorkerConfiguration,
} from "./mantis-local-runner.js";

const controller = new AbortController();

process.on("SIGTERM", () => controller.abort());
process.on("SIGINT", () => controller.abort());

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("Usage: mantis-local-worker <config.json>");
  const configuration = JSON.parse(fs.readFileSync(configPath, "utf8")) as MantisLocalWorkerConfiguration;
  const runtime = getProviderRuntime();
  await runMantisLocalClaude(configuration, {
    getSnapshot: (scanId) => runtime.store.getSnapshot(scanId),
    getConnection: (connectionId) => runtime.store.get(connectionId),
    getModel: (connectionId, modelId) => runtime.store.getModel(connectionId, modelId),
    signal: controller.signal,
    log: (line) => process.stdout.write(`${line}\n`),
  });
}

void main().catch((error) => {
  const code = error instanceof Error ? error.message : "agent_session_failed";
  process.stderr.write(`[mantis-local] ${code}\n`);
  process.exitCode = controller.signal.aborted ? 143 : 1;
});
