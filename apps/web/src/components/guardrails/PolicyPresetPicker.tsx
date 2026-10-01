import {
  guardrailPolicyPresetRules,
  type GuardrailPolicyPreset,
  type GuardrailRule,
} from "@csb/shared";

import { Panel, cx } from "../ui";
import { useI18n } from "../../i18n";
import type { TranslationKey } from "../../i18n";

/** The three a person can choose. `custom` is what the rules say, never a choice. */
const CHOOSABLE: ReadonlyArray<Exclude<GuardrailPolicyPreset, "custom">> = [
  "block-critical-high",
  "block-critical",
  "warn-only",
];

/**
 * Picks what the repository blocks, in words, and writes the preset's rules into the
 * editor below. Choosing a preset touches the **rules only**: the protected branches
 * and the scan envelope are different questions with their own answers, and a picker
 * that quietly re-priced a scan would be the opposite of a preset.
 *
 * `custom` is shown as the current state when the rules match no preset, and it is
 * not selectable: there is nothing to apply.
 */
export function PolicyPresetPicker({
  preset,
  readOnly,
  onChange,
}: {
  preset: GuardrailPolicyPreset;
  readOnly: boolean;
  onChange: (rules: GuardrailRule[]) => void;
}) {
  const { t } = useI18n();

  return <Panel
    label={t("guardrails.presetSection")}
    title={t("guardrails.presetTitle")}
    wrapTitle
    aside={preset === "custom" && <span className="inline-flex h-5 items-center border border-chart-5/45 px-1.5 font-mono text-[8px] uppercase tracking-wider text-chart-5">
      {t("guardrails.preset.custom")}
    </span>}
  >
    <p className="border-b px-4 py-3 text-xs leading-relaxed text-muted-foreground">
      {t(preset === "custom" ? "guardrails.preset.customDetail" : "guardrails.presetDescription")}
    </p>
    {/* One fixed grid for the three cards, so their titles and bodies start at the
        same x on every row rather than being measured per card. */}
    <div
      className="grid gap-px bg-border md:grid-cols-3"
      role="radiogroup"
      aria-label={t("guardrails.presetTitle")}
    >
      {CHOOSABLE.map((candidate) => {
        const selected = candidate === preset;
        return <button
          key={candidate}
          type="button"
          role="radio"
          aria-checked={selected}
          disabled={readOnly}
          onClick={() => onChange(guardrailPolicyPresetRules(candidate))}
          className={cx(
            "min-w-0 bg-background p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none",
            selected ? "bg-primary/[.07] shadow-[inset_3px_0_var(--primary)]" : "hover:bg-accent",
            readOnly && "cursor-not-allowed opacity-60 hover:bg-background",
          )}
        >
          <div className={cx("bench-label", selected && "text-primary")}>
            {t(`guardrails.preset.${candidate}` as TranslationKey)}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {t(`guardrails.preset.${candidate}Detail` as TranslationKey)}
          </p>
        </button>;
      })}
    </div>
  </Panel>;
}
