import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Inspect the Git index, not ignored local data. This command never deletes files.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
const generated = /(^|\/)(node_modules|dist|\.pnpm-store|\.superpowers|\.playwright-cli|test-results|playwright-report|\.worktrees|\.impeccable)(\/|$)|^(output|tmp)\//;
const localState = /^data\/(?!\.gitkeep$)|(^|\/)\.DS_Store$|\.(log|tsbuildinfo)$/;
const environmentFile = /(^|\/)\.env(?:\.|$)/;
const exampleEnvironment = /(^|\/)\.env\.(example|sample|template)$/;
const failures = files.filter((file) => generated.test(file) || localState.test(file)
  || (environmentFile.test(file) && !exampleEnvironment.test(file)));

if (failures.length) {
  console.error("Local state or generated artifacts must not be committed:\n" + failures.map((file) => `  ${file}`).join("\n"));
  process.exitCode = 1;
} else {
  const source = files.filter((file) => /\.(ts|tsx|js|mjs)$/.test(file));
  const tests = source.filter((file) => /\.(test|spec)\.[^.]+$/.test(file));
  const bytes = files.reduce((total, file) => {
    try { return total + statSync(resolve(root, file)).size; }
    catch (error) { if (error.code === "ENOENT") return total; throw error; }
  }, 0);
  console.log(`Repository hygiene passed: ${files.length} tracked files, ${tests.length} test files, ${(bytes / 1024 / 1024).toFixed(2)} MiB.`);
}
