import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const sourceDirectory = resolve(scriptDirectory, "..", "src");
const entries = await readdir(sourceDirectory, { recursive: true });
const testFiles = entries
  .filter((entry) => typeof entry === "string" && entry.endsWith(".test.ts"))
  .map((entry) => resolve(sourceDirectory, entry))
  .sort();

const child = spawn(
  process.execPath,
  ["--import", "tsx", "--test", ...testFiles],
  { stdio: "inherit" },
);

child.once("error", (error) => {
  throw error;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal === null ? 1 : 1);
});
