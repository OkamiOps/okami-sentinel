import type { ScanConnectionSelection, ScanMode, ScanRun } from "@csb/shared";
import type { TranslationKey } from "../i18n";

type Translate = (key: TranslationKey) => string;

export function executionProfileLabel(
  scan: Pick<ScanRun, "execution">,
  t: Translate,
): string | null {
  return scan.execution?.executionProfile === "native"
    ? t("newScan.profile.native")
    : scan.execution?.executionProfile === "portable"
      ? t("newScan.profile.portable")
      : null;
}

export function hasExecutionProfileMismatch(scans: readonly Pick<ScanRun, "execution">[]): boolean {
  const profiles = new Set(
    scans
      .map((scan) => scan.execution?.executionProfile)
      .filter((profile): profile is "native" | "portable" => profile !== undefined && profile !== null),
  );
  return profiles.size > 1;
}

export interface PortableRetryIntent {
  from: string;
  repositoryPath: string;
  engine: "codex-security";
  connectionId: string;
  modelSelectionMode: "catalog" | "runtime-default";
  modelId: string | null;
  mode: ScanMode;
  paths: string[];
}

type PortableRetryScan = Pick<
  ScanRun,
  "id" | "repositoryPath" | "engine" | "mode" | "execution" | "launchSelection"
>;

/**
 * A retry is offered only when the server persisted every launch identifier.
 * The URL deliberately carries no execution-profile preference: compatibility
 * is resolved again by the server from the registered connection.
 */
export function portableRetryHref(scan: PortableRetryScan): string | null {
  const intent = portableRetryIntentForScan(scan);
  if (intent === null) return null;
  const params = new URLSearchParams({
    from: intent.from,
    repositoryPath: intent.repositoryPath,
    engine: intent.engine,
    connectionId: intent.connectionId,
    modelSelectionMode: intent.modelSelectionMode,
    modelId: intent.modelId ?? "",
    mode: intent.mode,
    paths: intent.paths.join(","),
  });
  return `/scans/new?${params.toString()}`;
}

/** Parses only the retry identifiers emitted above; browser profile input is ignored. */
export function parsePortableRetryIntent(params: URLSearchParams): PortableRetryIntent | null {
  const from = requiredParam(params, "from");
  const repositoryPath = requiredParam(params, "repositoryPath");
  const engine = requiredParam(params, "engine");
  const connectionId = requiredParam(params, "connectionId");
  const modelSelectionMode = requiredParam(params, "modelSelectionMode");
  const rawModelId = requiredParam(params, "modelId", true);
  const mode = requiredParam(params, "mode");
  const rawPaths = requiredParam(params, "paths", true);
  if (
    !safeIdentifier(from) ||
    !safeRepositoryPath(repositoryPath) ||
    engine !== "codex-security" ||
    !safeIdentifier(connectionId) ||
    (modelSelectionMode !== "catalog" && modelSelectionMode !== "runtime-default") ||
    (mode !== "standard" && mode !== "deep") ||
    rawModelId === null ||
    rawPaths === null
  ) return null;

  const modelId = rawModelId === "" ? null : rawModelId;
  if (
    (modelSelectionMode === "catalog" && !safeIdentifier(modelId)) ||
    (modelSelectionMode === "runtime-default" && modelId !== null)
  ) return null;
  const paths = rawPaths === "" ? [] : rawPaths.split(",");
  if (paths.length > 256 || !paths.every(safeRetryPath)) return null;
  return {
    from,
    repositoryPath,
    engine,
    connectionId,
    modelSelectionMode,
    modelId,
    mode,
    paths,
  };
}

/** Prevents catalog/runtime defaults from silently replacing persisted retry state. */
export function selectionMatchesPortableRetry(
  intent: PortableRetryIntent,
  selection: ScanConnectionSelection | null,
): boolean {
  return selection !== null &&
    selection.connectionId === intent.connectionId &&
    selection.modelSelectionMode === intent.modelSelectionMode &&
    selection.modelId === intent.modelId;
}

function portableRetryIntentForScan(scan: PortableRetryScan): PortableRetryIntent | null {
  const execution = scan.execution;
  const launchSelection = scan.launchSelection;
  if (
    scan.engine !== "codex-security" ||
    execution?.executionProfile !== "portable" ||
    !safeIdentifier(scan.id) ||
    !safeRepositoryPath(scan.repositoryPath) ||
    !safeIdentifier(execution.connectionId) ||
    (scan.mode !== "standard" && scan.mode !== "deep") ||
    launchSelection === null ||
    launchSelection === undefined ||
    (launchSelection.modelSelectionMode !== "catalog" && launchSelection.modelSelectionMode !== "runtime-default") ||
    !Array.isArray(launchSelection.paths) ||
    launchSelection.paths.length > 256 ||
    !launchSelection.paths.every(safeRetryPath)
  ) return null;
  if (
    (launchSelection.modelSelectionMode === "catalog" && !safeIdentifier(launchSelection.modelId)) ||
    (launchSelection.modelSelectionMode === "runtime-default" && launchSelection.modelId !== null)
  ) return null;
  return {
    from: scan.id,
    repositoryPath: scan.repositoryPath,
    engine: "codex-security",
    connectionId: execution.connectionId,
    modelSelectionMode: launchSelection.modelSelectionMode,
    modelId: launchSelection.modelId,
    mode: scan.mode,
    paths: [...launchSelection.paths],
  };
}

function requiredParam(params: URLSearchParams, key: string, allowEmpty = false): string | null {
  if (!params.has(key)) return null;
  const value = params.get(key);
  return value !== null && (allowEmpty || value.length > 0) ? value : null;
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value &&
    value.length > 0 && value.length <= 512 && !/[\u0000-\u001F\u007F]/.test(value);
}

function safeRepositoryPath(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value &&
    value.length > 0 && value.length <= 4_096 && !/[\u0000-\u001F\u007F]/.test(value);
}

function safeRetryPath(value: unknown): value is string {
  return safeIdentifier(value) && value.length <= 1_024 && !value.includes(",") &&
    !value.startsWith("/") && !value.startsWith("\\") && !/^[A-Za-z]:[\\/]/.test(value) &&
    !value.split(/[\\/]+/).includes("..");
}
