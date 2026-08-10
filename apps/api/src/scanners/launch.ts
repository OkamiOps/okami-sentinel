import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ScannerAuthMode,
  ScannerEngine,
  ScanMode,
  StartScanRequest,
} from "@csb/shared";
import {
  CODEX_SECURITY_ARGS_PREFIX,
  CODEX_SECURITY_BIN,
  codexSecurityEnvironment,
  MANTIS_CACHE_DIR,
  MANTIS_REPOSITORY_URL,
  MANTIS_SOURCE_REF,
  MANTIS_WORKER_BIN,
  MANTIS_WORKER_ENTRY,
  ROOT_DIR,
  VULNHUNTER_PROFILE_VERSION,
  VULNHUNTER_REPOSITORY_URL,
  VULNHUNTER_SOURCE_REF,
  VULNHUNTER_WORKER_BIN,
  VULNHUNTER_WORKER_ENTRY,
} from "../config.js";
import type { MantisRunConfiguration } from "./mantis-runtime.js";
import type { VulnHunterRunConfiguration } from "./vulnhunter-runtime.js";

export interface ScannerLaunch {
  engine: ScannerEngine;
  authMode: ScannerAuthMode;
  provider: "openai";
  scannerVersion: string | null;
  recipeHash: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  displayCommand: string;
}

export interface ScannerLaunchInput {
  request: StartScanRequest;
  repositoryPath: string;
  outputDir: string;
  model: string;
  effort: string;
  mode: ScanMode;
}

export function explicitAuthEnvironment(
  authMode: ScannerAuthMode,
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = { ...source };
  if (authMode === "chatgpt") {
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    return env;
  }
  if (!env.OPENAI_API_KEY?.trim() && !env.CODEX_API_KEY?.trim()) {
    throw new Error(
      "Autenticação API selecionada, mas OPENAI_API_KEY/CODEX_API_KEY não está configurada no backend.",
    );
  }
  return env;
}

function recipeHash(input: {
  engine: ScannerEngine;
  authMode: ScannerAuthMode;
  model: string;
  effort: string;
  mode: string;
  paths: string[];
  scannerVersion: string | null;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
}

function prepareCodexSecurity(input: ScannerLaunchInput): ScannerLaunch {
  const authMode = input.request.authMode ?? "chatgpt";
  const args = [
    ...CODEX_SECURITY_ARGS_PREFIX,
    "scan",
    input.repositoryPath,
    "--auth",
    authMode,
    "--model",
    input.model,
    "--effort",
    input.effort,
    "--mode",
    input.mode,
    "--output-dir",
    input.outputDir,
    "--json",
  ];
  if (input.request.maxCostUsd != null && input.request.maxCostUsd > 0) {
    args.push("--max-cost", String(input.request.maxCostUsd));
  }
  for (const scopePath of input.request.paths ?? []) {
    if (scopePath.trim()) args.push("--path", scopePath.trim());
  }
  const hash = recipeHash({
    engine: "codex-security",
    authMode,
    model: input.model,
    effort: input.effort,
    mode: input.mode,
    paths: input.request.paths ?? [],
    scannerVersion: null,
  });
  return {
    engine: "codex-security",
    authMode,
    provider: "openai",
    scannerVersion: null,
    recipeHash: hash,
    command: CODEX_SECURITY_BIN,
    args,
    cwd: input.repositoryPath,
    env: explicitAuthEnvironment(authMode, codexSecurityEnvironment()),
    displayCommand: `${CODEX_SECURITY_BIN} ${args.join(" ")}`,
  };
}

function prepareMantis(input: ScannerLaunchInput): ScannerLaunch {
  const authMode = input.request.authMode ?? "chatgpt";
  const configuration: MantisRunConfiguration = {
    outputDir: input.outputDir,
    repositoryPath: input.repositoryPath,
    model: input.model,
    effort: input.effort,
    paths: (input.request.paths ?? []).map((item) => item.trim()).filter(Boolean),
    source: {
      repositoryUrl: MANTIS_REPOSITORY_URL,
      ref: MANTIS_SOURCE_REF,
      cacheDir: MANTIS_CACHE_DIR,
    },
  };
  const configPath = path.join(input.outputDir, "mantis-run.json");
  fs.writeFileSync(configPath, `${JSON.stringify(configuration, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  const hash = recipeHash({
    engine: "mantis",
    authMode,
    model: input.model,
    effort: input.effort,
    mode: input.mode,
    paths: configuration.paths,
    scannerVersion: MANTIS_SOURCE_REF,
  });
  const args = [MANTIS_WORKER_ENTRY, configPath];
  return {
    engine: "mantis",
    authMode,
    provider: "openai",
    scannerVersion: MANTIS_SOURCE_REF,
    recipeHash: hash,
    command: MANTIS_WORKER_BIN,
    args,
    cwd: ROOT_DIR,
    env: explicitAuthEnvironment(authMode, {
      ...process.env,
      NO_COLOR: "1",
      CI: "1",
    }),
    displayCommand: `sentinel-mantis ${path.basename(configPath)}`,
  };
}

function prepareVulnHunter(input: ScannerLaunchInput): ScannerLaunch {
  const authMode = input.request.authMode ?? "chatgpt";
  const configuration: VulnHunterRunConfiguration = {
    outputDir: input.outputDir,
    repositoryPath: input.repositoryPath,
    model: input.model,
    effort: input.effort,
    paths: (input.request.paths ?? []).map((item) => item.trim()).filter(Boolean),
    readOnly: true,
    profileVersion: VULNHUNTER_PROFILE_VERSION,
    source: {
      repositoryUrl: VULNHUNTER_REPOSITORY_URL,
      ref: VULNHUNTER_SOURCE_REF,
    },
  };
  const configPath = path.join(input.outputDir, "vulnhunter-run.json");
  fs.writeFileSync(configPath, `${JSON.stringify(configuration, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  const hash = recipeHash({
    engine: "vulnhunter",
    authMode,
    model: input.model,
    effort: input.effort,
    mode: input.mode,
    paths: configuration.paths,
    scannerVersion: VULNHUNTER_PROFILE_VERSION,
  });
  const args = [VULNHUNTER_WORKER_ENTRY, configPath];
  return {
    engine: "vulnhunter",
    authMode,
    provider: "openai",
    scannerVersion: VULNHUNTER_PROFILE_VERSION,
    recipeHash: hash,
    command: VULNHUNTER_WORKER_BIN,
    args,
    cwd: ROOT_DIR,
    env: explicitAuthEnvironment(authMode, {
      ...process.env,
      NO_COLOR: "1",
      CI: "1",
    }),
    displayCommand: `sentinel-vulnhunter ${path.basename(configPath)}`,
  };
}

export function prepareScannerLaunch(input: ScannerLaunchInput): ScannerLaunch {
  const engine = input.request.engine ?? "codex-security";
  if (engine === "codex-security") return prepareCodexSecurity(input);
  if (engine === "mantis") return prepareMantis(input);
  if (engine === "vulnhunter") return prepareVulnHunter(input);
  throw new Error(`Scanner não suportado: ${engine}`);
}
