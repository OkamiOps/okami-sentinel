import { CliArgumentError, parseArgs } from "./args.js";
import { runGateCli } from "./run.js";

async function main(): Promise<void> {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await runGateCli(options);
    console.log(`outcome=${result.artifact.decision.outcome}`);
    console.log(`artifact=${result.output}`);
    console.log(`cost_usd=${result.artifact.scan.cost?.estimatedUsd ?? 0}`);
    console.log(`findings=${result.artifact.findings.length}`);
    process.exitCode = result.exitCode;
  } catch (error) {
    const message = error instanceof CliArgumentError ? error.message : "Security gate failed before artifact creation";
    console.error(message);
    process.exitCode = 3;
  }
}

void main();
