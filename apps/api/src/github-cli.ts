import { spawn } from "node:child_process";

export interface GhResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GhRunner = (
  args: string[],
  options: { cwd: string; stdin?: string },
) => Promise<GhResult>;

export function createGhRunner(command = "gh"): GhRunner {
  return (args, options) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });
      child.stdin.end(options.stdin ?? "");
    });
}

export const defaultGhRunner = createGhRunner();
