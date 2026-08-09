# Contributing to OKAMI Sentinel

[English](CONTRIBUTING.md) · [Português (Brasil)](CONTRIBUTING.pt-BR.md) · [Deutsch](CONTRIBUTING.de.md) · [Français](CONTRIBUTING.fr.md)

Thank you for improving OKAMI Sentinel. Contributions should preserve three properties: local-first operation, evidence fidelity, and explicit security outcomes.

## Before you start

- Open an issue for large behavior, schema, or workflow changes.
- Keep pull requests focused; unrelated cleanup belongs in a separate change.
- Never commit scanner state, databases, logs, credentials, repository secrets, or personal paths.
- Generated findings are untrusted input. Escape and constrain them at every rendering or publication boundary.

## Local setup

```bash
corepack enable
corepack prepare pnpm@11.5.2 --activate
pnpm install
pnpm dev
```

Requirements and scanner authentication are documented in the [README](README.md#requirements).

## Required checks

Run the same gates as CI before opening a pull request:

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Pull request checklist

- [ ] The change has one clear purpose.
- [ ] Tests cover behavior or failure modes introduced by the change.
- [ ] Typecheck, tests, and build pass locally.
- [ ] User-facing text is present in all five UI dictionaries.
- [ ] Dates, numbers, and USD values use the shared formatters.
- [ ] Desktop and mobile layouts have been checked for overlap, clipping, and keyboard access.
- [ ] German and French labels were reviewed for longer text.
- [ ] Operational errors cannot be represented as a passing security result.
- [ ] Documentation and screenshots are updated when the workflow changes.

## UI and design contributions

- Preserve the dark Test Bench identity and the Evidence Spectrum visual language.
- Prefer shared shadcn/daisyUI primitives; do not recreate buttons, inputs, dialogs, or tables in bespoke CSS.
- Use Recharts or the existing chart primitives for data visualization.
- Color may reinforce meaning but must never be the only status signal.
- Respect `prefers-reduced-motion`, visible focus, and WCAG AA contrast.
- Verify print/PDF changes using an actual generated PDF, not only the browser page.

See the [design system](apps/web/DESIGN.md) and [product principles](apps/web/PRODUCT.md).

## Localization changes

Add the key to the canonical dictionary and provide PT-BR, English, Spanish, German, and French values in the same change. Do not automatically translate scanner-produced titles, summaries, code, paths, evidence, or logs.

See [localization architecture](docs/localization.md).

## Commit and review quality

Use concise, imperative commit messages. In the pull request, explain the problem, the chosen behavior, validation evidence, screenshots for visual changes, and any remaining limitation.

By contributing, you agree to follow the repository’s [security policy](SECURITY.md).
