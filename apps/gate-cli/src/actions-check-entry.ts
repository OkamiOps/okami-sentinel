import { publishActionsCheckFromEnvironment } from "./actions-check-publisher.js";

async function main(): Promise<void> {
  const artifactPath = process.argv[2];
  if (artifactPath === undefined) {
    console.error("Usage: publish-actions-check <gate-artifact.json>");
    process.exitCode = 3;
    return;
  }
  try {
    const result = await publishActionsCheckFromEnvironment(artifactPath);
    console.log(`check=${result}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Actions Check publication failed");
    process.exitCode = 3;
  }
}

void main();
