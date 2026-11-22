import path from "node:path";

export function normalizeScanScopePaths(paths: readonly string[]): string[] {
  const normalized = paths.map(value => path.posix.normalize(value.replace(/\\/g, "/")).replace(/\/+$/, ""));
  return normalized.includes(".") ? [] : [...new Set(normalized)].sort();
}

export function createScanScopeMatcher(paths: readonly string[] = []): (file: string) => boolean {
  const scopes = normalizeScanScopePaths(paths);
  return file => scopes.length === 0 || scopes.some(scope => file === scope || file.startsWith(`${scope}/`));
}
