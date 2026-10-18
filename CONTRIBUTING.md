# Contributing to OKAMI Sentinel

[English](CONTRIBUTING.md) · [Português (Brasil)](CONTRIBUTING.pt-BR.md) · [Deutsch](CONTRIBUTING.de.md) · [Français](CONTRIBUTING.fr.md)

Thank you for improving OKAMI Sentinel. Contributions should preserve three properties: local-first operation, evidence fidelity, and explicit security outcomes.

## Before you start

- Open an issue for large behavior, schema, or workflow changes. Use the [bug](.github/ISSUE_TEMPLATE/bug_report.md) and [feature](.github/ISSUE_TEMPLATE/feature_request.md) templates.
- Small, already scoped tasks are listed in [docs/good-first-issues.md](docs/good-first-issues.md).
- Keep pull requests focused. Unrelated cleanup belongs in a separate change.
- Never commit scanner state, databases, logs, credentials, repository secrets, or personal paths.
- Generated findings are untrusted input. Escape and constrain them at every rendering or publication boundary.
- Do not open a public issue for an exploitable vulnerability. Follow [SECURITY.md](SECURITY.md).

## Local setup

Requirements:

- Node.js `24.x` (`>=24 <25`). CI uses `24.17.0`.
- pnpm `11.5.2`, activated with Corepack.
- Python `3.10+` only for native Codex Security. Graphify’s isolated runtime is provisioned by `pnpm install`.
- GitHub CLI (`gh`) when the change touches GitHub diagnostics, remote baselines, or Check publication.
- Docker Engine with Compose v2 when the change touches `Dockerfile`, `compose*.yaml`, or `scripts/docker`.

```bash
corepack enable
corepack prepare pnpm@11.5.2 --activate
pnpm install
pnpm dev
```

- Web UI: <http://127.0.0.1:5173>
- Local API: <http://127.0.0.1:8787>

Scanner authentication and provider routes are documented in the [pnpm install](README.md#install-with-pnpm) section. If pnpm asks for build-script approval, run `pnpm approve-builds --all` and then `pnpm install` again.

There is no separate lint script. Static checking is `pnpm typecheck`. `pnpm check:repository` rejects committed local state, generated output, and non-example env files. It does not delete anything and it is not a secret scanner.

## Required checks

CI (`.github/workflows/ci.yml`) runs this sequence on Ubuntu with a frozen lockfile. Run the same gates before opening a pull request:

```bash
pnpm check:repository
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` is `pnpm -r --if-present test`. It runs the packages that define a `test` script (`@csb/api`, `@csb/web`, `@csb/gate-cli`, `@csb/gate-core`, `@csb/gate-runtime`). `@csb/shared` currently has none, so a change there is not covered until a test script exists.

For a UI change, also install the browser CI uses and run the mocked suite:

```bash
pnpm --filter @csb/web exec playwright install chromium
pnpm --filter @csb/web test:e2e
```

`pnpm test:e2e:real-api` is the real API and SQLite browser test. It does not call a provider. CI runs it after the mocked suite.

Changes to the Docker image or `scripts/docker` are covered by `.github/workflows/docker.yml` (`node --test scripts/docker/setup.test.mjs`, image build, and a smoke server). You do not need that workflow for a docs-only change.

## Commit messages

This repository uses Conventional Commits. History is `type(scope): summary`. Scope is optional.

Types already used here: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `perf`, `style`, `ci`, `revert`, `security`.

```
feat(web): show unknown severity on the evidence strip
fix(api): keep a failed dispatch from clearing the daily budget
docs: describe the Docker quickstart limits
```

There is no commitlint config. Write the subject so a reviewer can tell what changed. The summary is imperative or a specific sentence, matching the history. Do not use a generic subject such as `update` or `fix stuff`.

## Pull requests

The pull request template asks for three things: what changed, how you validated it, and what it does not prove.

- [ ] The change has one clear purpose.
- [ ] Tests cover behavior or failure modes introduced by the change.
- [ ] `pnpm check:repository`, typecheck, tests, and build pass locally.
- [ ] User-facing text is present in all five UI dictionaries: `pt-BR`, `en`, `es`, `de`, `fr`.
- [ ] Dates, numbers, and USD values use the shared formatters.
- [ ] Desktop and mobile layouts have been checked for overlap, clipping, and keyboard access.
- [ ] German and French labels were reviewed for longer text.
- [ ] Operational errors cannot be represented as a passing security result.
- [ ] Documentation and screenshots are updated when the workflow changes.

In the pull request body, explain the problem, the chosen behavior, the validation you ran, screenshots for visual changes, and any remaining limitation.

## UI and design contributions

- Preserve the dark Test Bench identity and the Evidence Spectrum visual language.
- Prefer shared shadcn/daisyUI primitives. Do not recreate buttons, inputs, dialogs, or tables in bespoke CSS.
- Use Recharts or the existing chart primitives for data visualization.
- Color may reinforce meaning but must never be the only status signal.
- Respect `prefers-reduced-motion`, visible focus, and WCAG AA contrast.
- Verify print/PDF changes using an actual generated PDF, not only the browser page.

See the [design system](apps/web/DESIGN.md) and [product principles](apps/web/PRODUCT.md).

## Localization changes

Add the key to the canonical `pt-BR` dictionary in `apps/web/src/i18n.tsx` and provide English, Spanish, German, and French values in the same change. Route-specific catalogues live under `apps/web/src/i18n/`. Do not automatically translate scanner-produced titles, summaries, code, paths, evidence, or logs.

See [localization architecture](docs/localization.md).

By contributing, you agree to follow the repository’s [security policy](SECURITY.md).
