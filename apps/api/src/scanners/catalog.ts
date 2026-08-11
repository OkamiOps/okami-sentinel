import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ScannerCatalogResponse,
  ScannerCapability,
  StartScanRequest,
} from "@csb/shared";
import {
  CODEX_BIN,
  CODEX_SECURITY_ARGS_PREFIX,
  CODEX_SECURITY_BIN,
  codexSecurityEnvironment,
  MANTIS_SOURCE_REF,
} from "../config.js";

const execFileAsync = promisify(execFile);
const CACHE_MS = 30_000;

interface RuntimeProbe {
  codexSecurityReady: boolean;
  codexSecurityChatGpt: boolean;
  codexReady: boolean;
  codexChatGpt: boolean;
  apiKeyAvailable: boolean;
}

let cached: { expiresAt: number; value: ScannerCatalogResponse } | null = null;

function withoutApiKeys(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  return env;
}

async function commandWorks(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      env,
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { ok: true, output: `${stdout}\n${stderr}`.trim() };
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string };
    return {
      ok: false,
      output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim(),
    };
  }
}

export function buildScannerCatalog(probe: RuntimeProbe): ScannerCatalogResponse {
  const codexSecurityAuth = [
    {
      id: "chatgpt" as const,
      available: probe.codexSecurityChatGpt,
      reason: probe.codexSecurityChatGpt
        ? null
        : "Codex Security has no stored ChatGPT sign-in.",
    },
    {
      id: "api-key" as const,
      available: probe.apiKeyAvailable,
      reason: probe.apiKeyAvailable
        ? null
        : "OPENAI_API_KEY or CODEX_API_KEY is not configured on the API process.",
    },
  ];
  const mantisAuth = [
    {
      id: "chatgpt" as const,
      available: probe.codexChatGpt,
      reason: probe.codexChatGpt
        ? null
        : "The Codex CLI has no stored ChatGPT sign-in.",
    },
  ];
  const vulnhunterAuth = [
    {
      id: "chatgpt" as const,
      available: probe.codexChatGpt,
      reason: probe.codexChatGpt
        ? null
        : "The Codex CLI has no stored ChatGPT sign-in.",
    },
  ];

  const scanners: ScannerCapability[] = [
    {
      engine: "codex-security",
      name: "Codex Security",
      enabled: true,
      available: probe.codexSecurityReady && codexSecurityAuth.some((auth) => auth.available),
      maturity: "stable",
      reason: probe.codexSecurityReady ? null : "Codex Security CLI is unavailable.",
      sourceUrl: "https://github.com/openai/codex-security",
      authModes: codexSecurityAuth,
      models: [
        { id: "gpt-5.6-sol", profile: "frontier" },
        { id: "gpt-5.6-terra", profile: "balanced" },
      ],
      efforts: ["minimal", "low", "medium", "high", "xhigh"],
      modes: ["standard", "deep"],
      stageCount: 6,
      writesTarget: false,
      executesGeneratedCode: false,
    },
    {
      engine: "mantis",
      name: "Google Mantis",
      enabled: true,
      available: probe.codexReady && mantisAuth.some((auth) => auth.available),
      maturity: "preview",
      reason: probe.codexReady
        ? null
        : "Codex CLI is unavailable; Mantis needs it as the inference host.",
      sourceUrl: "https://github.com/google/mantis",
      authModes: mantisAuth,
      models: [
        { id: "gpt-5.6-sol", profile: "frontier" },
        { id: "gpt-5.6-terra", profile: "balanced" },
      ],
      efforts: ["medium", "high", "xhigh"],
      modes: ["standard"],
      stageCount: 9,
      writesTarget: false,
      executesGeneratedCode: false,
    },
    {
      engine: "vulnhunter",
      name: "Capital One VulnHunter",
      enabled: true,
      available: probe.codexReady && vulnhunterAuth.some((auth) => auth.available),
      maturity: "experimental",
      reason: !probe.codexReady
        ? "Codex CLI is unavailable; the VulnHunter port needs it as the inference host."
        : vulnhunterAuth.find((auth) => !auth.available)?.reason ?? null,
      sourceUrl: "https://github.com/capitalone/vulnhunter",
      authModes: vulnhunterAuth,
      models: [{ id: "gpt-5.6-sol", profile: "frontier" }],
      efforts: ["high", "xhigh"],
      modes: ["standard"],
      stageCount: 6,
      writesTarget: false,
      executesGeneratedCode: false,
    },
  ];

  return { scanners, refreshedAt: new Date().toISOString() };
}

async function probeRuntimes(): Promise<RuntimeProbe> {
  const [securityInfo, securityLogin, codexVersion, codexLogin] = await Promise.all([
    commandWorks(
      CODEX_SECURITY_BIN,
      [...CODEX_SECURITY_ARGS_PREFIX, "info", "--json"],
      codexSecurityEnvironment(),
    ),
    commandWorks(
      CODEX_SECURITY_BIN,
      [...CODEX_SECURITY_ARGS_PREFIX, "login", "status"],
      withoutApiKeys(codexSecurityEnvironment()),
    ),
    commandWorks(CODEX_BIN, ["--version"], withoutApiKeys()),
    commandWorks(CODEX_BIN, ["login", "status"], withoutApiKeys()),
  ]);

  return {
    codexSecurityReady: securityInfo.ok,
    codexSecurityChatGpt:
      securityLogin.ok && /logged in using chatgpt/i.test(securityLogin.output),
    codexReady: codexVersion.ok,
    codexChatGpt: codexLogin.ok && /logged in using chatgpt/i.test(codexLogin.output),
    apiKeyAvailable: Boolean(
      process.env.OPENAI_API_KEY?.trim() || process.env.CODEX_API_KEY?.trim(),
    ),
  };
}

export async function getScannerCatalog(
  options: { fresh?: boolean } = {},
): Promise<ScannerCatalogResponse> {
  if (!options.fresh && cached && cached.expiresAt > Date.now()) return cached.value;
  const value = buildScannerCatalog(await probeRuntimes());
  cached = { expiresAt: Date.now() + CACHE_MS, value };
  return value;
}

export async function validateScannerRequest(req: StartScanRequest): Promise<ScannerCapability> {
  const engine = req.engine ?? "codex-security";
  // Connection-aware launches obtain availability/auth/model facts from the
  // persisted connection plan after a scan ID exists. Do not preflight the
  // legacy process environment first.
  const catalog = req.connection === undefined
    ? await getScannerCatalog()
    : buildScannerCatalog({
      codexSecurityReady: false,
      codexSecurityChatGpt: false,
      codexReady: false,
      codexChatGpt: false,
      apiKeyAvailable: false,
    });
  const scanner = catalog.scanners.find((candidate) => candidate.engine === engine);
  if (!scanner || !scanner.enabled) {
    throw new Error(`Scanner não suportado: ${engine}`);
  }

  // A selected connection is resolved immediately after the scan ID exists.
  // Its immutable route/model plan, rather than browser-supplied legacy fields
  // or this host's legacy CLI probe, decides authentication and availability.
  if (req.connection !== undefined) {
    validateMethodologyRequest(scanner, req);
    return scanner;
  }

  if (!scanner.available) {
    throw new Error(scanner.reason ?? `${scanner.name} não está disponível neste host.`);
  }
  const authMode = req.authMode ?? "chatgpt";
  const auth = scanner.authModes.find((candidate) => candidate.id === authMode);
  if (!auth?.available) {
    throw new Error(auth?.reason ?? `${scanner.name} não aceita autenticação ${authMode}.`);
  }
  if (req.provider && req.provider !== "openai") {
    throw new Error("A primeira entrega aceita somente o provider OpenAI.");
  }
  if (req.model && !scanner.models.some((candidate) => candidate.id === req.model)) {
    throw new Error(`Modelo ${req.model} não é válido para ${scanner.name}.`);
  }
  validateMethodologyRequest(scanner, req);
  return scanner;
}

function validateMethodologyRequest(
  scanner: ScannerCapability,
  req: StartScanRequest,
): void {
  if (req.effort && !scanner.efforts.some((candidate) => candidate === req.effort)) {
    throw new Error(`Effort ${req.effort} não é válido para ${scanner.name}.`);
  }
  if (req.mode && !scanner.modes.includes(req.mode)) {
    throw new Error(`Modo ${req.mode} não é válido para ${scanner.name}.`);
  }
  if (["mantis", "vulnhunter"].includes(scanner.engine) && req.maxCostUsd != null) {
    throw new Error(
      `${scanner.name} não consegue aplicar um teto USD neste runner; remova maxCostUsd.`,
    );
  }
}

export const MANTIS_VERSION = MANTIS_SOURCE_REF;
