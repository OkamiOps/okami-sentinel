<div align="center">
  <img src="apps/web/public/brand/okami-sentinel-mark.png" width="112" alt="OKAMI Sentinel wolf mark" />
  <h1>OKAMI Sentinel</h1>
  <p><strong>One local evidence workbench. Multiple security-scanning methodologies.</strong></p>
  <p>Run, inspect, compare, and govern AI-assisted security scans without losing the evidence, cost, or operational context behind each result.</p>

  <p>
    <a href="README.md"><strong>English</strong></a> ·
    <a href="README.pt-BR.md">Português (Brasil)</a> ·
    <a href="README.de.md">Deutsch</a> ·
    <a href="README.fr.md">Français</a>
  </p>

  <p>
    <a href="https://github.com/OkamiOps/okami-sentinel/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/OkamiOps/okami-sentinel/actions/workflows/ci.yml/badge.svg" /></a>
    <img alt="Node.js 24" src="https://img.shields.io/badge/Node.js-24.x-5FA04E?logo=nodedotjs&logoColor=white" />
    <img alt="pnpm 11.5.2" src="https://img.shields.io/badge/pnpm-11.5.2-F69220?logo=pnpm&logoColor=white" />
    <img alt="React 19" src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=0B0B12" />
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" />
    <img alt="Local first" src="https://img.shields.io/badge/architecture-local--first-11CDBB" />
  </p>
</div>

![OKAMI Sentinel overview showing run channels, severity composition, cost, and duration](docs/assets/okami-sentinel-overview.png)

> [!IMPORTANT]
> OKAMI Sentinel compares **reported evidence**, not ground-truth accuracy. More findings do not automatically mean a better scan, and a missing finding does not prove remediation. Confirm findings and triage false positives before using precision, recall, or F1.

## Why this exists

Security scans are usually reviewed in isolation: one terminal, one report, one bill. OKAMI Sentinel turns them into a comparable operating system. Every run becomes an evidence channel with its model, reasoning effort, duration, token volume, estimated cost, severity mix, findings, and execution state preserved in one local workspace.

It is built for developers, DevSecOps engineers, security reviewers, and AI engineers who need to evaluate scanner methodology and model choice separately across real repositories.

## What you get

| Surface | What it answers |
|---|---|
| **Evidence field** | What did each run report, and how is severity distributed? |
| **Run ledger** | Which scans completed, failed, or preserved partial evidence? |
| **Launch sequencer** | Which scanner, authentication route, model, effort, mode, and scope should run next? |
| **Evidence inspector** | Where is the finding, what is the attack path, and what evidence supports it? |
| **Comparison cockpit** | Which run reported more coverage, High+, speed, or cost efficiency? |
| **Reports** | How do I hand off one scan or a six-scan comparison as print-ready PDF? |
| **Guardrails** | Should this local changeset pass, warn, require review, or block? |
| **GitHub Checks** | How can the same versioned policy annotate and gate a pull request? |

<table>
  <tr>
    <td width="50%"><img src="docs/assets/okami-sentinel-compare.png" alt="Six-scan comparison cockpit with explicit objectives and partial-result warnings" /></td>
    <td width="50%"><img src="docs/assets/okami-sentinel-scan-detail.png" alt="Scan detail with cost, severity, baseline lifecycle, evidence list, and report action" /></td>
  </tr>
  <tr>
    <td align="center"><strong>Compare up to six scans</strong></td>
    <td align="center"><strong>Inspect evidence and lifecycle</strong></td>
  </tr>
</table>

## Core capabilities

- **Capability-aware scanner routing** — choose a methodology first; the UI then exposes only authentication, model, effort, and mode combinations the adapter can actually run.
- **Provider connections** — configure local sessions, managed browser/device authentication, API keys, Token Plan endpoints, or compatible custom APIs without putting credentials in scan manifests.
- **Live model discovery** — choose only models returned by the selected authenticated connection; Sentinel does not invent a fallback catalog.
- **Directory browser** — navigate local folders instead of manually copying absolute paths.
- **Live execution telemetry** — follow status, phase, SSE events, duration, tokens, estimated cost, and preserved output.
- **Evidence-first inspection** — filter by severity and lifecycle, inspect summaries and locations, and trace attack paths.
- **Honest partial results** — failed scans that preserved findings remain comparable with explicit `FAILED` and `PARTIAL` labels.
- **Six-run comparison** — one baseline plus up to five candidates, with severity diff, unit economics, throughput, and explicit decision objectives.
- **Print-ready reporting** — branded individual and comparison reports designed for browser printing and PDF export.
- **Versioned guardrails** — local preflight policies, explicit exceptions, decision graphs, and optional GitHub Checks publication.
- **Five UI locales** — PT-BR, English, Español, Deutsch, and Français with persisted browser preference.

## Scanner engines

| Engine | Status | Runnable connection routes | Models | Execution boundary |
|---|---|---|---|---|
| [`@openai/codex-security`](https://github.com/openai/codex-security) | Stable | OpenAI local Codex/ChatGPT session or OpenAI API | Authenticated live catalog | Standard or deep scan; explicit USD ceiling supported |
| [Google Mantis](https://github.com/google/mantis) | Preview | Codex/ChatGPT session, Claude Code local session, direct xAI OAuth, and capability-proven HTTP providers | Authenticated live catalog; Claude may use its explicit runtime default | Nine deterministic scan-only stages on an immutable snapshot |
| [Capital One VulnHunter](https://github.com/capitalone/vulnhunter) | Experimental | Codex/ChatGPT session, direct xAI OAuth, and capability-proven HTTP providers | Authenticated live catalog | Six-stage, read-only static compatibility profile derived from the reviewed VulnHunter methodology |

Mantis is fetched at a reviewed commit, validated, and atomically published into a private local cache. Phase one deliberately excludes `mantis-reproduce`, `mantis-chain`, and `mantis-patch`: the adapter does not write to the target repository and does not execute generated exploit code. HTTP routes run through Sentinel's bounded agent tool host. Claude Code subscription runs use a separate empty session directory, no built-in tools, and one private read-only MCP server exposing only bounded list, read, and search operations over the immutable snapshot. Raw Mantis state remains beside normalized Sentinel evidence for auditability.

VulnHunter's upstream workflow is Claude-oriented and intentionally includes operational verification stages that can trigger provider cyber safeguards. Sentinel therefore records the reviewed upstream revision as provenance for its separately versioned local profile, but does **not** fetch or send the upstream skill or its phase prompts to Codex at runtime. Its experimental compatibility profile keeps the useful shape—reconnaissance, forward static traces, adversarial falsification, coverage sweep, and evidence-backed remediation—inside one read-only session over an immutable snapshot. Retained findings are normalized into the same Inspector evidence contract used by the other engines. Provider policy can still reject a repository review; when that happens Sentinel preserves the full run log, retains any token usage already reported by the Codex app-server, and reports the Trusted Access requirement instead of pretending the scanner completed. If the provider stops before reporting usage, cost remains unavailable rather than appearing as a false zero-dollar run.

> [!NOTE]
> Subscription, OAuth, Token Plan, and API billing are separate routes. Sentinel binds every scan to one persisted connection and one live-discovered model, revalidates that tuple before credential access, and never silently falls from one route into another.

## Architecture

```mermaid
flowchart LR
    UI["React workbench\nVite + Tailwind + daisyUI"]
    API["Local API\nHono + Node.js"]
    DB[("SQLite\nbenchmark metadata")]
    STATE[("Codex Security state\nscan output + evidence")]
    CONNECTIONS["Provider connections\nlocal · OAuth · API · Token Plan"]
    VAULT[("OS credential vault")]
    MODELS[("Live model catalogs\n+ capability probes")]
    ROUTER["Capability router\nengine × connection × model"]
    CODEXSEC["Codex Security adapter"]
    MANTIS["Mantis scan-only adapter\npinned skills + snapshot"]
    VULNHUNTER["VulnHunter compatibility profile\nversioned locally + static traces"]
    GATE["Guardrail engine\npolicy + decision graph"]
    GH["GitHub Actions\nChecks + artifacts"]

    UI -->|HTTP + SSE| API
    API --> DB
    API --> STATE
    API --> CONNECTIONS
    CONNECTIONS --> VAULT
    CONNECTIONS --> MODELS
    MODELS --> ROUTER
    API --> ROUTER
    ROUTER --> CODEXSEC
    ROUTER --> MANTIS
    ROUTER --> VULNHUNTER
    API --> GATE
    GATE -. optional .-> GH
```

| Layer | Technology | Location |
|---|---|---|
| Web application | React 19, Vite, TypeScript, Tailwind CSS, daisyUI, shadcn, Recharts, Framer Motion | `apps/web` |
| Local API | Node.js, Hono | `apps/api` |
| Gate CLI | Headless security-change gate | `apps/gate-cli` |
| Gate engine | Policy evaluation and runtime integration | `packages/gate-core`, `packages/gate-runtime` |
| Shared contracts | Cross-package types and schemas | `packages/shared` |
| Metadata | SQLite | `data/benchmark.db` |

## Requirements

- Node.js `24.x` (`>=24 <25`)
- pnpm `11.5.2`
- Python `3.10+` for Codex Security
- GitHub CLI (`gh`) for GitHub diagnostics, remote baselines, and optional Check publication
- GitHub Actions enabled in repositories using the remote gate
- An OS credential store supported by the local keychain adapter for secret-backed connections
- At least one configured route under **Settings → Connections**. Available presets include:
  - OpenAI local Codex, ChatGPT browser/device authentication, and OpenAI API;
  - xAI local Grok detection, device OAuth orchestrated locally by Sentinel, and xAI API;
  - Claude Code local session and Anthropic API;
  - Cursor local detection and Cursor Background Agents API;
  - OpenRouter, Gemini, DeepSeek, MiniMax Token Plan, Xiaomi MiMo Token Plan, and custom OpenAI- or Anthropic-compatible APIs.

## Quick start

```bash
git clone https://github.com/OkamiOps/okami-sentinel.git
cd okami-sentinel
corepack enable
corepack prepare pnpm@11.5.2 --activate
pnpm install
pnpm dev
```

If pnpm requests build-script approval:

```bash
pnpm approve-builds --all
pnpm install
```

Open:

- Web UI: <http://127.0.0.1:5173>
- Local API: <http://127.0.0.1:8787>

Open **Settings → Connections** to add a route, authenticate it, and refresh its model catalog. Local subscription routes still use their official login:

```bash
npx @openai/codex-security login
# or
npx @openai/codex-security login --device-auth

# Codex-hosted Mantis and VulnHunter use the generic Codex session
codex login

# Claude-local Mantis uses the existing Claude Code session
claude auth login
```

At startup, the API indexes compatible scans already present in the configured Codex Security state directory.

## Typical workflow

1. **Overview** — inspect indexed channels, severity composition, cost, and duration.
2. **Operate** — browse to a repository, choose the scanner methodology, then select an available authentication route, model, effort, mode, and scope.
3. **Activity / Scan detail** — follow telemetry and inspect preserved evidence.
4. **Compare** — select two to six runs, choose a baseline, and evaluate coverage, High+, `$ / finding`, `$ / High+`, and speed.
5. **Report** — generate an individual report from scan detail or a comparison report after running the diff.
6. **Guardrails** — evaluate a local changeset against a versioned policy and optionally publish the result as a GitHub Check.

## Provider connections

| Provider family | Connection routes | Scanner availability |
|---|---|---|
| **OpenAI** | Local Codex, ChatGPT browser OAuth, ChatGPT device code, API key | Codex Security, Mantis, VulnHunter according to the resolved route |
| **xAI** | Device OAuth orchestrated locally by Sentinel, API key, local Grok detection | OAuth/API may run Mantis and VulnHunter after capability proof. Grok local scanning remains blocked until its plugin/hook execution surface can be isolated. |
| **Anthropic** | Claude Code existing session, Anthropic API | Claude local runs Mantis through Sentinel's MCP-only snapshot boundary. API models require a successful capability probe. |
| **Cursor** | Local CLI detection, Background Agents API | Connection and live catalog support are available; scanner execution is not advertised until the remote/local artifact contract is complete. |
| **Other HTTP** | OpenRouter, Gemini, DeepSeek, MiniMax Token Plan, MiMo Token Plan, custom compatible URLs | Mantis/VulnHunter only when the exact model passes Sentinel's bounded tool, artifact, cancellation, and snapshot probe. |

Models come from the authenticated provider catalog. The only runtime-default exception is an explicitly configured Claude Code local session. Secrets and OAuth tokens are write-only through the API, stored in the OS credential vault, and represented in SQLite only by opaque references. Sentinel orchestrates xAI's public device flow locally and does not invoke or depend on Grok CLI; model access is accepted only after live catalog and capability checks succeed.

## Local guardrails

Guardrails evaluate a Git changeset and preserve the evidence used in the decision.

1. Enroll the root of a local Git repository.
2. Run preflight with base and head references such as `main` and `HEAD`.
3. Inspect the effective changeset, scanner scope, policy outcome, and Decision Graph.
4. Edit `.csb/guardrails.json` visually and review the before/after JSON.
5. Record time-bounded exceptions in `.csb/guardrails-exceptions.json`.

| Outcome | Meaning | GitHub conclusion | CLI exit |
|---|---|---|---:|
| `no_changes` | No changed files between refs | `success` | 0 |
| `bootstrap` | No baseline exists; never treated as approval | `neutral` | 0 |
| `pass` | No blocking or review rule fired | `success` | 0 |
| `warning` | Policy requires review | `neutral` | 0 |
| `blocked` | A blocking rule fired | `failure` | 2 |
| `error` | Operational failure; never converted to approval | `action_required` | 3 |

<details>
<summary><strong>Use the reusable GitHub Actions gate</strong></summary>

Create `.github/workflows/csb-security-change-gate.yml` in the target repository:

```yaml
name: CSB Security Change Gate
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
  pull-requests: read
  actions: read
  checks: write
jobs:
  security-change-gate:
    uses: OkamiOps/okami-sentinel/.github/workflows/security-change-gate.yml@v1
    with:
      policy_path: .csb/guardrails.json
      default_branch: main
    secrets:
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

Use the versioned `@v1` reference; `@main` is not accepted as a gate release. Configure the exact required-check name **`CSB Security Change Gate`** in branch protection.

Fork pull requests usually cannot read base-repository secrets. Missing scanner authentication ends as operational exit `3`, never as a false-success Check.
</details>

<details>
<summary><strong>GitHub capability troubleshooting</strong></summary>

- **Git repository:** `git rev-parse --show-toplevel`
- **GitHub remote:** verify `remote.origin.url` points to `github.com/<owner>/<repo>`
- **GitHub CLI:** `gh --version`
- **Authentication:** `gh auth status`, then `gh auth login` when required
- **Subscription:** `codex login status`, then `codex login` when required
- **API secret:** `gh secret list --json name` must include `OPENAI_API_KEY`
- **Caller workflow:** verify the file, `@v1`, and the minimum permissions shown above
- **Remote baseline:** confirm the default branch produced a retained `csb-gate-artifact`

Expired, missing, or schema-invalid artifacts are operational errors. They never trigger a silent bootstrap.
</details>

## Reports

- **Individual report:** generated from scan detail, with executive summary, severity profile, findings, locations, and evidence.
- **Comparison report:** generated from a completed diff with one baseline and up to five candidates.
- **Output:** browser print preview or Save as PDF.
- **Pagination:** report sections are A4-aware and protect metrics, headers, and finding blocks from internal clipping.

## Localization

The UI detects the browser language on first visit and stores the selection under `okami-sentinel.locale`.

| Code | Language | UI support |
|---|---|---:|
| `pt-BR` | Português do Brasil (fallback) | Yes |
| `en` | English | Yes |
| `es` | Español | Yes |
| `de` | Deutsch | Yes |
| `fr` | Français | Yes |

Dates and numbers follow the active locale. Financial values remain explicitly denominated in USD. Scanner-produced titles, summaries, paths, code, evidence, and logs remain in their original language to avoid changing technical meaning.

See [localization architecture](docs/localization.md).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CODEX_SECURITY_STATE_DIR` | Global state when writable; otherwise `data/codex-security-state` | Scanner state and output |
| `CODEX_SECURITY_BIN` | `npx` | Scanner CLI executable |
| `CSB_NPM_CACHE_DIR` | `data/npm-cache` | Isolated npm cache used by scanner `npx` |
| `CODEX_BIN` | ChatGPT Desktop bundled CLI on macOS, otherwise `codex` | Explicit Codex CLI override used as the Mantis and VulnHunter inference host |
| `MANTIS_REPOSITORY_URL` | `https://github.com/google/mantis.git` | Reviewed Mantis source repository |
| `MANTIS_SOURCE_REF` | Pinned reviewed commit | Exact Mantis revision used by new runs |
| `MANTIS_CACHE_DIR` | `data/mantis-cache` | Local cache for the pinned Mantis skills |
| `VULNHUNTER_REPOSITORY_URL` | `https://github.com/capitalone/vulnhunter.git` | VulnHunter source repository recorded as methodology provenance |
| `VULNHUNTER_SOURCE_REF` | Reviewed commit label | VulnHunter methodology revision recorded as provenance; it is not fetched at runtime |
| `CSB_HOST` | `127.0.0.1` | API bind address |
| `CSB_PORT` | `8787` | API port |
| `CSB_MAX_CONCURRENT_SCANS` | `8` | Maximum concurrent scanner processes |

For ChatGPT-subscription runs on macOS, Sentinel prefers the Codex executable bundled with ChatGPT Desktop. This keeps the inference host aligned with the shared authentication and model-cache schema; an explicit `CODEX_BIN` always wins.

## Development

```bash
pnpm dev          # API + web
pnpm dev:api      # API only
pnpm dev:web      # web only
pnpm typecheck
pnpm test
pnpm build
```

```text
okami-sentinel/
├── apps/
│   ├── api/           # local HTTP/SSE API
│   ├── gate-cli/      # headless gate command
│   └── web/           # React workbench and reports
├── packages/
│   ├── gate-core/     # policies and decision model
│   ├── gate-runtime/  # scanner/runtime integration
│   └── shared/        # shared contracts
├── docs/              # architecture and product documentation
└── data/              # local metadata and runtime state (ignored where sensitive)
```

## Cost and security notes

> [!WARNING]
> Scans can be expensive. Codex Security's cost envelope maps to its `--max-cost` guardrail. When a provider reports token usage and an exact price is available, Sentinel may show an explicitly sourced estimate; it is not an invoice. Subscription and local-session routes remain **unavailable**, never `$0`, when the provider does not report billable usage. OpenRouter estimates price uncached input, cache reads, cache writes, and output separately for an exact model match. Plan allowances, credits, and final provider billing remain different measurements.

- Metadata and normalized evidence remain local. Provider credentials are stored locally and used only to authenticate requests for the selected connection. That inference route receives the prompts and repository evidence needed for the scan; publishing a GitHub Check is a separate explicit action.
- Operational failures never become a passing security decision.
- Deleting a scan is explicit and can remove both the application record and the associated managed scan directory.
- Treat generated findings as untrusted security evidence until reviewed.

## Project documentation

- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Localization architecture](docs/localization.md)
- [Product principles](apps/web/PRODUCT.md)
- [Design system](apps/web/DESIGN.md)

## Status

This repository is under active development. Interfaces, local schemas, and the reusable gate may change before a stable release. Pin the gate to a versioned release reference and review changes before upgrading.

---

<div align="center">
  <sub>Independent local workbench for AI-assisted security scanners. OKAMI Sentinel is not an official OpenAI, Google, or Capital One product.</sub>
</div>
