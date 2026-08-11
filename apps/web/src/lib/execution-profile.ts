import type { ScanRun } from "@csb/shared";
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
