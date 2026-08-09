# Product principles

[English](PRODUCT.md) · [Português (Brasil)](PRODUCT.pt-BR.md) · [Deutsch](PRODUCT.de.md) · [Français](PRODUCT.fr.md)

<!-- impeccable:product-schema 1 -->

## Platform

Web application with a local API.

## Users

Developers, DevSecOps professionals, security reviewers, and AI Engineers use the product individually to operate scans and collaboratively to review evidence, cost, and technical efficiency.

## Product purpose

OKAMI Sentinel is a local workbench for launching `@openai/codex-security` scans, following execution, inspecting findings, measuring estimated cost, and comparing model/effort combinations. Success means finding relevant risk with enough context to act while understanding the cost of each scan strategy.

## Positioning

The product joins security evidence and execution telemetry. Findings, severity, model, effort, duration, tokens, and estimated cost live in one comparable flow.

## Operating context

The product is used during development and security review against local repositories. Scans can be long-running, partial, or expensive; results must remain readable during execution and afterward. The primary flow is overview → new scan → activity/detail → comparison → report.

## Capabilities and constraints

- Local React/Vite interface, Hono API, and metadata mirrored in SQLite.
- Existing compatible scans are indexed from Codex Security state.
- The UI supports PT-BR, English, Spanish, German, and French; browser locale is detected and the selection persists locally.
- Comparisons accept one baseline and up to five candidates.
- Interrupted scans that preserved findings remain available as explicitly labeled partial results.
- Individual and comparison reports reuse the evidence, cost, and efficiency model shown in the product and can be printed or exported as PDF.
- Cost values are token-based estimates, not confirmed billing.
- High-per-dollar comparisons are heuristics, not proof of accuracy.
- Scanner-generated evidence remains in its source language to preserve technical meaning.
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
