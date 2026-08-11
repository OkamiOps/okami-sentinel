import type { ScanRun, ScannerEngine } from "@csb/shared";

const engineNames: Record<ScannerEngine, string> = {
  "codex-security": "Codex Security",
  mantis: "Google Mantis",
  vulnhunter: "Capital One VulnHunter",
};

type LedgerIdentityInput = Pick<ScanRun, "engine" | "model" | "severity">;

export function scanLedgerIdentity(scan: LedgerIdentityInput) {
  return {
    engine: engineNames[scan.engine],
    model: scan.model ?? "Provider default",
    highPlus: scan.severity.critical + scan.severity.high,
    total: scan.severity.total,
  };
}
