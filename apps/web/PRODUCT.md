# Product principles

[English](PRODUCT.md) · [Português (Brasil)](PRODUCT.pt-BR.md) · [Deutsch](PRODUCT.de.md) · [Français](PRODUCT.fr.md)

<!-- impeccable:product-schema 1 -->

## Platform

Web application with a local API.

## Users

Developers, DevSecOps professionals, security reviewers, and AI Engineers use the product individually to operate scans and collaboratively to review evidence, cost, and technical efficiency.

## Product purpose

OKAMI Sentinel is a local workbench for running Codex Security, Google Mantis, and Capital One VulnHunter scans; following execution; inspecting findings; measuring estimated cost; and comparing model/effort combinations. Codex Security resolves a Native upstream contract or a Sentinel-owned Portable defensive profile before launch. Success means finding relevant risk with enough context to act while understanding the cost and execution boundary of each scan strategy.

## Positioning

The product joins security evidence and execution telemetry. Findings, severity, model, effort, duration, tokens, and estimated cost live in one comparable flow.

## Operating context

The product is used during development and security review against local checkouts or explicitly authorized GitHub repositories. Scans can be long-running, partial, or expensive; results must remain readable during execution and afterward. The primary flow is overview → new scan → activity/detail → comparison → report.

## Capabilities and constraints

- Local React/Vite interface, Hono API, and metadata mirrored in SQLite.
- Guardrails accepts two explicit repository authorities: a local checkout or a private GitHub App installation. Remote targets must resolve to immutable base/head SHAs before execution; implicit remote `HEAD` and silent fallback to local state are forbidden.
- A remote gate runs either from a Sentinel-managed immutable snapshot or from a repository-owned GitHub Actions caller pinned to one full release SHA. Sentinel can install or update that caller through the authorized GitHub App and stores user-selected push, pull-request, and post-merge triggers in the workflow itself. Remote policy remains read-only; only the workflow publishes GitHub Checks.
- Existing compatible scans are indexed from configured local scanner state and Sentinel-managed outputs.
- Engine, connection, protocol, execution profile, and model selection are resolved and pinned before launch. A scan pins either a live-catalog model or, only when the adapter declares it, an explicit runtime default. A tuple that requires a capability probe is not eligible until its fresh matching probe succeeds; Sentinel never silently falls back to a different route, model, or profile.
- Models and reasoning-effort choices come from the selected runtime/provider catalog. When a provider does not publish effort metadata, Sentinel leaves effort provider-managed instead of inventing options.
- The UI supports PT-BR, English, Spanish, German, and French; browser locale is detected and the selection persists locally.
- Comparisons accept one baseline and up to five candidates.
- Interrupted scans that preserved findings remain available as explicitly labeled partial results.
- Portable keeps a server-owned dossier and emits report pages only for confirmed candidates. Those private internal pages are validated and consolidated into one final report; rejected candidates and their coverage are server-derived. If a page or its validation fails, no partial final report is published.
- When a terminal artifact fails validation, Portable allows only a small bounded repair window within the scan's existing global turn, tool, elapsed-time, and configured-cost limits.
- Standard and deep scans classify only findings from the current execution as `new`, `persisting`, or `regressed` against a compatible same-lineage baseline. A missing finding is not remediation; `fixed` remains reserved for a future explicit incremental contract.
- Individual and comparison reports reuse the evidence, cost, and efficiency model shown in the product and can be printed or exported as PDF.
- Cost appears only when reported usage and matching pricing data are available; otherwise it is unavailable, never an invented zero or a subscription invoice. Portable's optional USD ceiling uses reported usage and a frozen matching quote: it blocks the next request after the ceiling is reached, while one request already in flight can take the estimate above it.
- High-per-dollar comparisons are heuristics, not proof of accuracy.
- Scanner-generated evidence remains in its source language to preserve technical meaning.
- The run ledger exposes engine and model identity alongside High+ and total findings, so a row can be understood without opening its detail view.
- Only terminal scans can be explicitly removed after confirmation. Sentinel removes the local record and, when applicable, its managed artifacts; it never removes the analyzed repository or external paths.
- Desktop, mobile, keyboard, visible focus, and reduced-motion support are product requirements.

## Brand commitments

The product retains the OKAMI Sentinel name and its technical security-benchmark nature. The primary theme is dark. The interface must avoid generic SaaS patterns and behave like a security instrument without copying other products or inventing claims.

## Evidence on hand

- Real scan metadata, metrics, and findings exposed by the local API.
- Visual references supplied during the August 2026 redesign.
- The OKAMI Sentinel identity supplied for the product and reports; no unapproved brand variants or commercial claims.

## Product principles

- Show signal before decoration.
- Keep risk and cost readable in the same decision.
- Separate operational state, evidence, and estimation.
- Support fast individual reading and clear team handoff.
- Preserve raw data and make destructive actions explicit.
- Never describe missing evidence as remediation without confirmation.

## Accessibility and inclusion

WCAG AA contrast, keyboard navigation, non-color status labels, comfortable targets, readable long German/French strings, and `prefers-reduced-motion` support are product requirements.
