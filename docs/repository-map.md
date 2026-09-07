# Repository map and maintenance

OKAMI Sentinel is a local evidence workbench. Source files, local scan evidence,
installed dependencies, and engineering reports have different lifecycles.

| Path | Purpose | Maintenance rule |
| --- | --- | --- |
| `apps/api/src` | HTTP API, SQLite persistence, ingestion, scanner orchestration, provider connections, agent and guardrail domains | Keep production modules and their co-located tests. Child-process workers and the snapshot MCP server are runtime entrypoints even without static imports. |
| `apps/api/scripts/run-tests.mjs` | Recursively discovers `src/**/*.test.ts` with isolated test data | Preserve discovery when reorganizing tests. |
| `apps/web/src` | React interface and five interface languages | Keep user-facing translations consistent across pt-BR, en, es, de, fr. |
| `apps/web/e2e` | Browser regressions; separate mocked and real-API suites | Real-API tests use a temporary SQLite database and controlled executable, never a real provider. |
| `packages` | Shared contracts and reusable gate core/runtime | Preserve API and web contract compatibility. |
| `scripts` | Repository checks and isolated E2E supervision | No production-only test routes or credentials. |
| `docs/architecture` | Dated product and security design records | Historical design intent, not proof that every proposed feature is implemented. Validate against source and tests. |
| `data` | Local database, scan evidence, engine state and caches | Ignored except `.gitkeep`. Never clean indiscriminately; retention needs an explicit policy and recovery path. |
| `node_modules`, `.pnpm-store` | Installed packages and pnpm store | Ignored and reproducible. Apparent sizes can overlap through shared files. |
| `output` | Local reports and retained verification evidence | Ignored. Remove only task-owned temporary artifacts; preserve `output/worktree-archives`. |
| `.superpowers` | Local agent/brainstorm working state | Ignored, not application source. Keep secrets out of general-purpose archives. |

## Checks

Use Node.js 24 and the pinned pnpm version:

```sh
pnpm check:repository
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @csb/web test:e2e
pnpm test:e2e:real-api
```

The repository check examines Git-tracked paths. It rejects generated output,
local runtime data, dependency directories and non-example environment files;
it does not delete anything and is not a secret-content scanner.
The real-API suite requires the Playwright Chromium installation used by CI.

## Dashboard metrics

`GET /metrics/summary` aggregates the entire filtered population in SQLite, while
`recent` contains at most 100 scans and `costTrend` at most 200 priced points.
`recentTotal` and `costTrendTotal` expose the corresponding full counts.
The initial migration recovers missing terminal sidecars and drains legacy
projection/category batches before the API starts serving. Subsequent polling
refreshes active scans only. This makes the first upgraded startup more expensive
than a warm start; its cost depends on historical artifacts.
Persisted price snapshots remain stable. An indexed run without a quote stays
unquoted until it is ingested/refreshed again; a catalog refresh alone does not
change historical dashboard values. Explicit `/ingest` refreshes external scans
and category snapshots; scanner detail refresh handles artifact-managed runs.

## Archived execution plans

The eight plans formerly under `docs/superpowers/plans` were execution history,
not runtime inputs. Their original versions remain recoverable from Git commit
`45fe6a79bf59f5784caaff9db401ee3a2f85de8f`:

```sh
git show 45fe6a79bf59f5784caaff9db401ee3a2f85de8f:docs/superpowers/plans/2026-08-07-attack-path-workbench.md
```

The five design specifications were retained under `docs/architecture` with
unchanged content. A local hash-verified archive and manifest of the removed
execution history are retained in `output/project-wave3-audit/archives`.
