import type { GateFindingLifecycle, GuardrailRule, Severity } from "@csb/shared";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useI18n } from "../../i18n";
import { cx } from "../ui";

const severities: Severity[] = ["critical", "high", "medium", "low", "info", "unknown"];
const lifecycles: GateFindingLifecycle[] = ["new", "reopened", "persistent", "fixed"];

export function PolicyRuleEditor({
  rules,
  onChange,
}: {
  rules: GuardrailRule[];
  onChange: (rules: GuardrailRule[]) => void;
}) {
  const { t } = useI18n();

  function update(index: number, next: GuardrailRule) {
    onChange(rules.map((rule, ruleIndex) => ruleIndex === index ? next : rule));
  }

  function move(index: number, offset: -1 | 1) {
    const target = index + offset;
    if (target < 0 || target >= rules.length) return;
    const next = [...rules];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  }

  return (
    <section className="bench-panel min-w-0" aria-labelledby="policy-rules-title">
      <div className="flex min-h-11 items-center justify-between gap-3 border-b px-4 py-2.5">
        <div>
          <div className="bench-label text-primary">ORDERED RULES</div>
          <h2 id="policy-rules-title" className="mt-0.5 text-sm font-semibold">{t("guardrails.rulesTitle")}</h2>
        </div>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={() => onChange([...rules, { severity: ["high"], lifecycle: ["new"], decision: "review" }])}
        >
          <Plus aria-hidden size={14} />{t("guardrails.addRule")}
        </Button>
      </div>
      <div>
        {rules.map((rule, index) => (
          <fieldset key={index} className="border-b p-4 last:border-b-0">
            <legend className="sr-only">{t("guardrails.ruleLegend", { index: index + 1 })}</legend>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-primary">RULE {String(index + 1).padStart(2, "0")}</div>
                <p className="mt-1 text-xs text-muted-foreground">{t("guardrails.ruleOrderHelp")}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="ghost" className="min-h-11" disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp aria-hidden size={13} />{t("guardrails.moveUp")}</Button>
                <Button type="button" variant="ghost" className="min-h-11" disabled={index === rules.length - 1} onClick={() => move(index, 1)}><ArrowDown aria-hidden size={13} />{t("guardrails.moveDown")}</Button>
                <Button type="button" variant="ghost" className="min-h-11 text-destructive hover:text-destructive" disabled={rules.length === 1} onClick={() => onChange(rules.filter((_, ruleIndex) => ruleIndex !== index))}><Trash2 aria-hidden size={13} />{t("guardrails.removeRule")}</Button>
              </div>
            </div>

            <div className="mt-4 grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_12rem]">
              <ChoiceGroup
                label={t("guardrails.severity")}
                values={severities}
                selected={rule.severity}
                onToggle={(value) => update(index, { ...rule, severity: toggle(rule.severity, value) })}
              />
              <ChoiceGroup
                label={t("guardrails.lifecycle")}
                values={lifecycles}
                selected={rule.lifecycle}
                onToggle={(value) => update(index, { ...rule, lifecycle: toggle(rule.lifecycle, value) })}
              />
              <div>
                <label className="text-sm font-semibold" htmlFor={`policy-rule-${index}-decision`}>{t("guardrails.decision")}</label>
                <Select value={rule.decision} onValueChange={(decision: GuardrailRule["decision"]) => update(index, { ...rule, decision })}>
                  <SelectTrigger id={`policy-rule-${index}-decision`} className="mt-2 min-h-11 w-full rounded-none"><SelectValue /></SelectTrigger>
                  <SelectContent position="popper" className="rounded-none border-border bg-popover">
                    <SelectItem value="block" className="min-h-11 rounded-none">{t("guardrails.block")}</SelectItem>
                    <SelectItem value="review" className="min-h-11 rounded-none">{t("guardrails.requestReview")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </fieldset>
        ))}
      </div>
    </section>
  );
}

function ChoiceGroup<T extends string>({
  label,
  values,
  selected,
  onToggle,
}: {
  label: string;
  values: readonly T[];
  selected: readonly T[];
  onToggle: (value: T) => void;
}) {
  return (
    <fieldset>
      <legend className="text-sm font-semibold">{label}</legend>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {values.map((value) => {
          const checked = selected.includes(value);
          return (
            <label key={value} className={cx("flex min-h-11 cursor-pointer items-center gap-2 border px-3 text-xs transition-colors hover:bg-accent", checked && "border-primary bg-primary/[.06] text-primary")}>
              <input type="checkbox" className="checkbox checkbox-sm checkbox-primary" checked={checked} onChange={() => onToggle(value)} />
              <span>{value}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function toggle<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}
