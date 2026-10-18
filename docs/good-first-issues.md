# Starter issues

Concrete tasks already visible in this tree. Each one is small enough for a first pull request. The maintainer can paste a title into GitHub and apply the `good first issue` label.

Do not treat a design note under `docs/architecture/` as proof that a feature is unfinished. The items below point at code or docs that disagree with the behavior they describe.

## 1. Localize the overview severity labels

**Title:** fix(web): localize overview severity labels

The overview composition and the category list hardcode English. `severityChannels` in `apps/web/src/pages/DashboardPage.tsx` uses `Critical`, `High`, `Medium`, `Low`, and `Info`. The same file writes `` `${total} findings` `` in `SelectedComposition`, and writes the English fragment `high+` in the category legend, the category rows, and `TraceTooltip`.

Use the existing dictionary keys (`compare.severity.*` or `guardrails.severityValue.*`) in all five locales. Add a key where one does not exist, including Portuguese in the canonical `pt-BR` object. Do not fold `unknown` into `info` as part of this change. That is a separate task.

**Files:** `apps/web/src/pages/DashboardPage.tsx`, `apps/web/src/i18n.tsx`

## 2. Draw `unknown` on the severity strip

**Title:** fix(web): show unknown severity on the evidence strip

`Severity` in `packages/shared/src/index.ts` includes `unknown`. `SeverityStrip` in `apps/web/src/components/ui.tsx` accepts that count and then draws only critical, high, medium, low, and info. `SelectedComposition` in `apps/web/src/pages/DashboardPage.tsx` adds `unknown` into the info segment, so the two surfaces disagree.

Draw `unknown` as its own segment, with a translated label and a non-color cue. Stop adding it to info. A zero count stays hidden, matching the other segments.

**Files:** `apps/web/src/components/ui.tsx`, `apps/web/src/pages/DashboardPage.tsx`, `apps/web/src/i18n.tsx`

## 3. Translate the indeterminate progress name

**Title:** fix(web): translate the scanner progress name

`ProgressTrack` in `apps/web/src/components/ui.tsx` sets the accessible name to the English string `Scanner activity` when the caller does not pass `label`. `Loading` in the same file already uses `t("common.loading")`.

Add one dictionary key, provide pt-BR, en, es, de, and fr, and use it for that fallback.

**Files:** `apps/web/src/components/ui.tsx`, `apps/web/src/i18n.tsx`

## 4. Replace hardcoded `unknown` fallbacks

**Title:** fix(web): translate unknown path and policy-source fallbacks

Two operator-facing fallbacks are English literals:

- `locationLabel` in `apps/web/src/pages/ScanDetailPage.tsx` uses `"unknown"` when a finding location has no path.
- `PortfolioPipeline.tsx` uses `"unknown"` when a gate has no `policySource`.

Add dictionary strings in the five locales. Leave scanner-produced paths, titles, and evidence in their original language.

**Files:** `apps/web/src/pages/ScanDetailPage.tsx`, `apps/web/src/components/guardrails/PortfolioPipeline.tsx`, `apps/web/src/i18n.tsx`

## 5. Translate Portuguese compare severity labels

**Title:** fix(web): translate pt-BR compare severity labels

In the canonical `pt-BR` dictionary, `compare.severity.critical`, `high`, `medium`, and `low` are still the English words `Critical`, `High`, `Medium`, and `Low` (`apps/web/src/i18n.tsx`). The same file already translates the guardrail severity values as `Crítico`, `Alto`, `Médio`, and `Baixo`. Spanish, German, and French already translate the compare keys.

Change only the Portuguese compare labels so they match the guardrail wording. Do not retarget the English dictionary.

**Files:** `apps/web/src/i18n.tsx`

## 6. Test the MiMo model alias helpers

**Title:** test(shared): cover MiMo v2.5 to v2.6 aliases

`packages/shared/src/mimo-models.ts` maps retired chat ids onto v2.6 and answers alias questions. `packages/shared/package.json` has no `test` script, and the root `pnpm test` uses `--if-present`, so this package is skipped.

Add `tsx` as a dev dependency and `"test": "tsx --test src/*.test.ts"`, matching `@csb/gate-core`. Cover `canonicalMimoTokenPlanModelId`, `retiredMimoTokenPlanModelId`, `isRetiredMimoTokenPlanModelId`, `isMimoTokenPlanAgentModelId`, `mimoTokenPlanModelIdsMatch`, and `mimoTokenPlanModelAliases`, including an unknown id that must pass through. Do not change the successor map.

**Files:** `packages/shared/package.json`, `packages/shared/src/mimo-models.ts`, a new `packages/shared/src/mimo-models.test.ts`

## 7. Publish an English Docker guide

**Title:** docs: add an English Docker guide

`docs/docker.md` is the operator guide for setup, ports, backups, and health checks, and it is written in Portuguese. The English README links to it from the quickstart. `docs/dokploy.md` is also Portuguese and links back to `docs/docker.md`.

Add an English guide as `docs/docker.md` and keep the current text as `docs/docker.pt-BR.md`, which is the same pattern as `README.md` and `README.pt-BR.md`. Update links in `README.md`, `README.de.md`, `README.fr.md`, `README.pt-BR.md`, `CHANGELOG.md`, and `docs/dokploy.md`. Translate the steps. Do not change them.

**Files:** `docs/docker.md`, `docs/docker.pt-BR.md`, the README language files, `CHANGELOG.md`, `docs/dokploy.md`

## 8. Replace the superseded GitHub page

**Title:** docs: replace the superseded GitHub monitoring page

`docs/github-monitoring.md` is Portuguese and opens by marking itself superseded by `docs/architecture/2026-09-30-github-guardrails-design.md`. The English README still points at it for setup and limits. `CHANGELOG.md` does too.

Write a short English operator page from the shipped UI and API: `apps/web/src/components/github/` and `apps/api/src/github-actions/`. Cover enroll, sync, budgeted actions, and the fetch/pull limits that the current README already states. Do not document the removed poller or a one-rule-per-repository limit. Point the README and changelog links at the new page.

**Files:** `docs/github-monitoring.md`, `README.md`, `CHANGELOG.md`, `apps/web/src/components/github/`, `apps/api/src/github-actions/`

## 9. Mirror the launch README in the other languages

**Title:** docs: mirror the launch README in pt-BR, de, and fr

`README.pt-BR.md`, `README.de.md`, and `README.fr.md` still open with the pre-launch header. The English `README.md` now has the tagline, badges, `docs/assets/launch/sentinel-demo.gif`, Why Sentinel, the Docker quickstart, the four launch screenshots, the contributing close, and the license note.

Copy that structure into the three translations. Keep every technical claim aligned with the English page. Do not add engines, numbers, or benchmarks that the English page does not state.

**Files:** `README.pt-BR.md`, `README.de.md`, `README.fr.md`, `README.md`

## 10. Update the translated contributing guides

**Title:** docs: update translated CONTRIBUTING guides

`CONTRIBUTING.pt-BR.md`, `CONTRIBUTING.de.md`, and `CONTRIBUTING.fr.md` still describe an older check list. They omit `pnpm check:repository`, the Playwright and real-API commands, the absence of a lint script, and the Conventional Commits types used in this repository's history (`feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `perf`, `style`, `ci`, `revert`, `security`).

Translate the current `CONTRIBUTING.md`. Keep the command lines in English. Do not invent a commitlint or ESLint step.

**Files:** `CONTRIBUTING.md`, `CONTRIBUTING.pt-BR.md`, `CONTRIBUTING.de.md`, `CONTRIBUTING.fr.md`
