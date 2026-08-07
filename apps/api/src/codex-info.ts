import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CodexInfo } from "@csb/shared";
import {
  CODEX_SECURITY_ARGS_PREFIX,
  CODEX_SECURITY_BIN,
  codexSecurityEnvironment,
} from "./config.js";

const execFileAsync = promisify(execFile);

export async function getCodexInfo(): Promise<CodexInfo | null> {
  try {
    const { stdout } = await execFileAsync(
      CODEX_SECURITY_BIN,
      [...CODEX_SECURITY_ARGS_PREFIX, "info", "--json"],
      {
        env: codexSecurityEnvironment(),
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    const raw = JSON.parse(stdout) as Record<string, unknown>;
    return {
      cliVersion: typeof raw.cliVersion === "string" ? raw.cliVersion : undefined,
      sdkVersion: typeof raw.sdkVersion === "string" ? raw.sdkVersion : undefined,
      model: typeof raw.model === "string" ? raw.model : undefined,
      reasoningEffort:
        typeof raw.reasoningEffort === "string" ? raw.reasoningEffort : undefined,
      raw,
    };
  } catch {
    return null;
  }
}
