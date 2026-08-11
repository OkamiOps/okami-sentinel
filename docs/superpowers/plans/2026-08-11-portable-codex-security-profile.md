# Portable Codex Security Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing Codex Security scanner card execute through a capability-proven Sentinel Portable profile for non-native providers while preserving the upstream Native profile, immutable provenance, complete Inspector output, telemetry, and cost semantics.

**Architecture:** The control plane resolves `native` or `portable` before vault/network access and persists the resolved profile. Native continues to launch the real `@openai/codex-security`; Portable runs six bounded static-analysis stages through the existing `AgentSession` and provider adapters, then normalizes evidence into the same Inspector pipeline with a distinct recipe identity.

**Tech Stack:** TypeScript, Node 24, Hono, SQLite/better-sqlite3, React 19, Vite, Tailwind/DaisyUI/shadcn primitives, existing AgentSession and provider connection runtime.

## Global Constraints

- Keep one user-facing scanner engine: `codex-security`; distinguish execution with `executionProfile: "native" | "portable"`.
- Never silently change profiles after credentials, network, or child-process launch.
- Resolve and pin connection/model/probe/profile/snapshot before reading credentials.
- Portable receives only `workspace.list`, `workspace.read`, `workspace.search`, and `results.write`; no shell, browser, network tool, MCP, dynamic tool, or arbitrary write.
- Never infer models, reasoning efforts, context windows, pricing, or capabilities from model/provider names.
- Keep secrets, private endpoint values, provider response bodies, and custom headers out of public DTOs, manifests, logs, telemetry, errors, reports, and snapshots.
- Unknown usage or pricing is `null`, never USD 0.00.
- All new UI copy must exist in English, Portuguese (Brazil), Spanish, German, and French.
- Preserve the current responsive selection frames; validate 390x844, 817x900, and 1440x1000.
- Use the repository-declared Node `>=24 <25` runtime for every gate.
- Do not add OpenRouter/Fireworks/Bedrock Native drivers in this plan; they are a separate follow-up. Existing OpenAI Native behavior must not regress.

---

## File Structure

### New backend files

- `apps/api/src/scanners/portable-codex-security-profile.ts` — versioned six-stage methodology, schemas, prompt construction, safe provider plan.
- `apps/api/src/scanners/portable-codex-security-runtime.ts` — durable runtime state, atomic read/write, progress and usage.
- `apps/api/src/scanners/portable-codex-security-http-runner.ts` — exact tuple/snapshot/probe/vault resolution and bounded AgentSession creation.
- `apps/api/src/scanners/portable-codex-security-worker.ts` — child entrypoint and closed error output.
- `apps/api/src/scanners/portable-codex-security-worker-support.ts` — stage loop, event serialization, artifact allowlist and usage aggregation.
- `apps/api/src/scanners/portable-codex-security-normalize.ts` — schema validation, evidence anchoring and normalized Inspector records.
- `apps/api/src/scanners/portable-codex-security-reconcile.ts` — runtime/findings reconciliation into `ScanRun`.
- `apps/api/src/model-pricing.ts` — pure frozen catalog-pricing calculation.

### Modified backend/shared files

- `packages/shared/src/index.ts` — execution-profile/provenance DTOs and generic pricing source.
- `apps/api/src/connections-store.ts` — immutable profile snapshot fields.
- `apps/api/src/db.ts` — durable run provenance and full `ScanCost` JSON.
- `apps/api/src/connections/compatibility-resolver.ts` — Native/Portable resolution.
- `apps/api/src/connections/scan-compatibility.ts` — public profile-aware preview.
- `apps/api/src/connections/launch-plan.ts` — immutable resolved profile.
- `apps/api/src/scanners/scan-selection.ts` — Portable plan acceptance and stale-browser rejection.
- `apps/api/src/scanners/launch.ts` — secret-free Portable worker configuration.
- `apps/api/src/runner.ts` — Portable launch/reconcile wiring.
- `apps/api/src/ingest.ts` and `apps/api/src/progress.ts` — Portable disk recovery and progress.
- `apps/api/src/compare.ts` and `apps/api/src/app.ts` — profile-aware report/comparison output.

### Modified web files

- `apps/web/src/api.ts` — profile-aware compatibility/report DTO usage.
- `apps/web/src/lib/new-scan-routing.ts` — profile copy/reason mapping and Portable retry request.
- `apps/web/src/pages/NewScanPage.tsx` — resolved profile in authorization panel.
- `apps/web/src/pages/ScanDetailPage.tsx` — provenance and explicit retry action.
- `apps/web/src/pages/ScanReportPage.tsx` — report provenance.
- `apps/web/src/pages/ComparePage.tsx` and `CompareReportPage.tsx` — profile identity/warning.
- `apps/web/src/i18n.tsx` — five-locale copy.
- `README.md` — Native versus Portable behavior and capability gate.

---

### Task 1: Shared profile contracts and durable provenance

**Files:**
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/api/src/connections-store.ts`
- Modify: `apps/api/src/db.ts`
- Test: `apps/api/src/connections-store.test.ts`
- Test: `apps/api/src/db.test.ts`
- Test: `apps/api/src/db-usage.test.ts`

**Interfaces:**
- Produces: `CodexSecurityExecutionProfile`, `CodexSecurityProfilePreference`, `ScanExecutionProvenance`, profile-aware `ConnectionCompatibility`, `ScanConnectionSnapshot`, `ScanRun`, and generic frozen catalog pricing.
- Consumes: existing `CapabilityReport`, `ProviderModel`, `ScanCost`, and SQLite migration helpers.

- [ ] **Step 1: Write failing profile round-trip tests**

Add cases that write/read snapshots and runs with Portable provenance, then prove secrets and endpoint values are absent:

```ts
const provenance = {
  executionProfile: "portable",
  profileVersion: "sentinel-codex-security-portable-v1",
  methodologyRef: "sentinel/codex-security-methodology@v1",
  capabilityCheckId: "cap-1",
} as const;

store.writeSnapshot({
  scanId: "scan-1",
  connectionId: "connection-1",
  routeKind: "mimo-token-plan",
  modelSelectionMode: "catalog",
  modelId: "mimo-v2.5",
  capabilityCheckId: "cap-1",
  executionProfile: "portable",
  profileVersion: provenance.profileVersion,
  methodologyRef: provenance.methodologyRef,
  capturedAt: "2026-08-11T09:00:00.000Z",
});

assert.deepEqual(store.getSnapshot("scan-1"), expectedSnapshot);
assert.equal(JSON.stringify(store.getSnapshot("scan-1")).includes("secret"), false);
```

Add a DB round-trip where `cost.pricingSource === "provider-catalog"`, full rate/breakdown metadata survives reload, and `cost: null` remains null.

- [ ] **Step 2: Run the RED tests**

Run:

```bash
pnpm --filter @csb/api exec node --import tsx --test \
  src/connections-store.test.ts src/db.test.ts src/db-usage.test.ts
```

Expected: FAIL because profile/provenance fields and generic cost persistence do not exist.

- [ ] **Step 3: Add the shared contracts**

Add these exact contracts and extend existing DTOs without adding a new scanner engine:

```ts
export type CodexSecurityExecutionProfile = "native" | "portable";
export type CodexSecurityProfilePreference = "auto" | CodexSecurityExecutionProfile;

export interface ScanExecutionProvenance {
  executionProfile: CodexSecurityExecutionProfile;
  profileVersion: string;
  methodologyRef: string;
  capabilityCheckId: string | null;
  connectionId: string | null;
  routeKind: string | null;
  protocol: ProviderProtocol | null;
  authKind: ConnectionAuthKind | null;
}

export interface ConnectionCompatibility extends ScanConnectionSelection {
  eligible: boolean;
  reasons: string[];
  selectedProfile?: CodexSecurityExecutionProfile | null;
  availableProfiles?: CodexSecurityExecutionProfile[];
  profileVersion?: string | null;
  methodologyRef?: string | null;
  capabilityCheckId?: string | null;
}
```

Extend `ScanConnectionSnapshot` with nullable profile, protocol, and auth-kind fields; extend `StartScanRequest` with `executionProfilePreference?: CodexSecurityProfilePreference`; and extend `ScanRun` with `execution: ScanExecutionProvenance | null`. Keep `ScanRun.authMode` as legacy scanner-CLI metadata; `execution.authKind` is the only authoritative connection-auth value for connection-aware runs.

Extend `ScanCost.pricingSource` to `"openrouter" | "provider-catalog"` and add optional frozen rates:

```ts
pricingSnapshot?: {
  currency: "USD";
  capturedAt: string;
  inputUsdPerMillionTokens: number | null;
  cachedInputUsdPerMillionTokens: number | null;
  cacheWriteInputUsdPerMillionTokens: number | null;
  outputUsdPerMillionTokens: number | null;
};
```

`cacheWriteInputUsdPerMillionTokens` is stored as `null` in this delivery because the current `ModelPricing` catalog contract does not publish a cache-write rate. Cache-write tokens remain visible usage, but they are excluded from the estimated total unless a future catalog contract supplies an explicit rate.

- [ ] **Step 4: Add idempotent SQLite migrations**

In `connections-store.ts`, add nullable `execution_profile`, `profile_version`, `methodology_ref`, `protocol`, and `auth_kind` columns to `scan_connection_snapshots`; include them in insert/select/mappers.

In `db.ts`, add nullable `execution_profile`, `profile_version`, `methodology_ref`, `capability_check_id`, and `cost_json` columns. Persist the complete sanitized `ScanCost` in `cost_json`; read legacy scalar columns when `cost_json` is null. Do not persist connection secrets or endpoint configuration.

- [ ] **Step 5: Run GREEN gates and commit**

Run:

```bash
pnpm --filter @csb/api exec node --import tsx --test \
  src/connections-store.test.ts src/db.test.ts src/db-usage.test.ts
pnpm --filter @csb/shared typecheck
pnpm --filter @csb/api typecheck
git diff --check
```

Expected: all PASS.

Commit:

```bash
git add packages/shared/src/index.ts apps/api/src/connections-store.ts apps/api/src/db.ts \
  apps/api/src/connections-store.test.ts apps/api/src/db.test.ts apps/api/src/db-usage.test.ts
git commit -m "feat: persist Codex Security execution profiles"
```

---

### Task 2: Profile-aware compatibility and immutable launch plans

**Files:**
- Create: `apps/api/src/scanners/portable-codex-security-profile.ts`
- Modify: `apps/api/src/connections/compatibility-resolver.ts`
- Modify: `apps/api/src/connections/scan-compatibility.ts`
- Modify: `apps/api/src/connections/launch-plan.ts`
- Modify: `apps/api/src/scanners/scan-selection.ts`
- Test: `apps/api/src/connections/compatibility-resolver.test.ts`
- Test: `apps/api/src/connections/scan-compatibility.test.ts`
- Test: `apps/api/src/connections/launch-plan.test.ts`
- Test: `apps/api/src/scanners/scan-selection.test.ts`

**Interfaces:**
- Consumes: Task 1 profile/provenance contracts and existing complete `CapabilityReport`.
- Produces: `resolveCodexSecurityProfiles(...)`, `SafePortableCodexSecurityProviderPlan`, and `ScanLaunchPlan.execution`.

- [ ] **Step 1: Write a table-driven RED matrix**

Add cases for the exact visible routes:

```ts
const portableRoutes = [
  ["openrouter-api", "openai-chat"],
  ["gemini-api", "openai-chat"],
  ["deepseek-api", "openai-chat"],
  ["mimo-token-plan", "openai-chat"],
  ["custom-openai-compatible", "openai-chat"],
  ["anthropic-api", "anthropic-messages"],
  ["minimax-token-plan", "anthropic-messages"],
  ["custom-anthropic-compatible", "anthropic-messages"],
  ["xai-api", "openai-responses"],
  ["xai-oauth", "xai-oauth-responses"],
] as const;
```

For each route, assert:

- a fresh complete probe resolves `selectedProfile: "portable"`;
- a missing/stale/failed/mismatched probe blocks with the exact safe reason;
- `executionProfilePreference: "native"` blocks instead of silently choosing Portable;
- existing OpenAI API/ChatGPT paths resolve Native;
- profile and capability ID are written into the immutable snapshot;
- browser-forged profile/provenance fields cannot change the resolved plan.

- [ ] **Step 2: Run RED control-plane tests**

Run:

```bash
pnpm --filter @csb/api exec node --import tsx --test \
  src/connections/compatibility-resolver.test.ts \
  src/connections/scan-compatibility.test.ts \
  src/connections/launch-plan.test.ts \
  src/scanners/scan-selection.test.ts
```

Expected: FAIL because Codex Security currently hard-blocks non-OpenAI routes.

- [ ] **Step 3: Define the Portable profile constants and safe plan**

Create:

```ts
export const PORTABLE_CODEX_SECURITY_PROFILE_VERSION =
  "sentinel-codex-security-portable-v1" as const;
export const PORTABLE_CODEX_SECURITY_METHODOLOGY_REF =
  "sentinel/codex-security-methodology@v1" as const;

export interface SafePortableCodexSecurityProviderPlan {
  scanId: string;
  connectionId: string;
  routeKind: string;
  protocol: Extract<ProviderProtocol,
    "openai-responses" | "openai-chat" | "anthropic-messages" | "xai-oauth-responses">;
  modelId: string;
  capabilityCheckId: string;
  profileVersion: typeof PORTABLE_CODEX_SECURITY_PROFILE_VERSION;
  methodologyRef: typeof PORTABLE_CODEX_SECURITY_METHODOLOGY_REF;
}
```

`createSafePortableCodexSecurityProviderPlan(plan)` must reject every missing/mismatched field and copy identifiers only.

- [ ] **Step 4: Resolve Native and Portable from server facts**

Refactor the Codex Security branch to compute `availableProfiles`:

```ts
const native = isCodexSecurityRoute(input.connection);
const portableReasons = validateAgentProbe(input);
const portable = input.connection.transport === "http-inference" &&
  portableReasons.length === 0 &&
  isHttpAgentRouteProtocolSupported(input.connection.routeKind, input.connection.protocol);
```

Apply preference deterministically: explicit Native or Portable must be eligible; Auto prefers Native, then Portable. Return profile version/methodology and capability ID. Remove the MiMo brand-specific early block; its unproven Native contract remains unavailable, while its proven Portable contract is allowed.

Update `runnerIsWired`, `LaunchPlanResolver`, snapshots, and `resolveScanLaunchSelection` so `agent-session + codex-security + portable` is accepted only with a model and exact capability ID.

- [ ] **Step 5: Run GREEN gates and commit**

Run the focused command from Step 2, then:

```bash
pnpm --filter @csb/api typecheck
git diff --check
```

Expected: all PASS.

Commit:

```bash
git add apps/api/src/scanners/portable-codex-security-profile.ts \
  apps/api/src/connections/compatibility-resolver.ts \
  apps/api/src/connections/scan-compatibility.ts \
  apps/api/src/connections/launch-plan.ts apps/api/src/scanners/scan-selection.ts \
  apps/api/src/connections/compatibility-resolver.test.ts \
  apps/api/src/connections/scan-compatibility.test.ts \
  apps/api/src/connections/launch-plan.test.ts apps/api/src/scanners/scan-selection.test.ts
git commit -m "feat: resolve Portable Codex Security profiles"
```

---

### Task 3: Portable methodology, runtime, and evidence normalization

**Files:**
- Modify: `apps/api/src/scanners/portable-codex-security-profile.ts`
- Create: `apps/api/src/scanners/portable-codex-security-runtime.ts`
- Create: `apps/api/src/scanners/portable-codex-security-normalize.ts`
- Test: `apps/api/src/scanners/portable-codex-security-runtime.test.ts`
- Test: `apps/api/src/scanners/portable-codex-security-normalize.test.ts`

**Interfaces:**
- Consumes: Task 1 shared usage/provenance types and Task 2 profile constants.
- Produces: six stage definitions, exact artifact schemas, atomic runtime state, progress conversion, `normalizePortableCodexSecurityWorkspace(...)`.

- [ ] **Step 1: Write RED tests for stage and evidence contracts**

Test the exact artifacts:

```ts
const requiredArtifacts = [
  "01-inventory.json",
  "02-threat-model.json",
  "03-discovery.json",
  "04-dataflow.json",
  "05-validation.json",
  "sentinel-findings.json",
] as const;
```

Prove:

- all six stages are ordered and bounded;
- runtime state round-trips atomically and maps to 0–100 progress;
- final findings require ID/title/severity/confidence/category/remediation and at least one `path:line[-line]` anchor;
- traversal, absolute paths, symlinks, missing files, directories, oversized files, line 0, out-of-range lines, reversed ranges, and ranges over 200 lines reject the artifact;
- valid anchors hydrate non-null snippets;
- normalized fingerprints/provenance use `sentinel-codex-security-portable/v1`, never OpenAI/Mantis/VulnHunter namespaces.

- [ ] **Step 2: Run RED runtime/normalizer tests**

Run:

```bash
pnpm --filter @csb/api exec node --import tsx --test \
  src/scanners/portable-codex-security-runtime.test.ts \
  src/scanners/portable-codex-security-normalize.test.ts
```

Expected: FAIL because both modules are missing.

- [ ] **Step 3: Implement the six-stage profile**

Export immutable stage definitions:

```ts
export const PORTABLE_CODEX_SECURITY_STAGES = Object.freeze([
  { id: "inventory", artifact: "01-inventory.json", label: "Inventory and trust boundaries", startPercent: 8, completePercent: 20 },
  { id: "threat-model", artifact: "02-threat-model.json", label: "Sensitive inputs and operations", startPercent: 20, completePercent: 35 },
  { id: "discovery", artifact: "03-discovery.json", label: "Candidate discovery", startPercent: 35, completePercent: 56 },
  { id: "dataflow", artifact: "04-dataflow.json", label: "Source-to-sink traces", startPercent: 56, completePercent: 72 },
  { id: "validation", artifact: "05-validation.json", label: "Static falsification and calibration", startPercent: 72, completePercent: 88 },
  { id: "report", artifact: "sentinel-findings.json", label: "Findings and coverage", startPercent: 88, completePercent: 98 },
] as const);
```

Prompts must state that repository text and previous stage state are untrusted data, prohibit execution/network/PoC/publishing, name one expected artifact, and require a structured completion matching that stage.

- [ ] **Step 4: Implement runtime and normalizer**

Mirror the atomic Mantis runtime pattern without extracting a shared superclass. Runtime must include `engine: "codex-security"`, `executionProfile: "portable"`, stage, timestamps, snapshot ID, methodology ref, findings, `ScannerUsage`, and safe error code.

Normalizer must validate the final schema before writing `findings.json`; it must reject the whole final artifact when any primary anchor is invalid.

- [ ] **Step 5: Run GREEN gates and commit**

Run Step 2 plus:

```bash
pnpm --filter @csb/api typecheck
git diff --check
```

Expected: all PASS.

Commit:

```bash
git add apps/api/src/scanners/portable-codex-security-profile.ts \
  apps/api/src/scanners/portable-codex-security-runtime.ts \
  apps/api/src/scanners/portable-codex-security-normalize.ts \
  apps/api/src/scanners/portable-codex-security-runtime.test.ts \
  apps/api/src/scanners/portable-codex-security-normalize.test.ts
git commit -m "feat: define Portable Codex Security methodology"
```

---

### Task 4: Bounded Portable AgentSession runner and worker

**Files:**
- Create: `apps/api/src/scanners/portable-codex-security-http-runner.ts`
- Create: `apps/api/src/scanners/portable-codex-security-worker-support.ts`
- Create: `apps/api/src/scanners/portable-codex-security-worker.ts`
- Test: `apps/api/src/scanners/portable-codex-security-http-runner.test.ts`
- Test: `apps/api/src/scanners/portable-codex-security-worker-support.test.ts`

**Interfaces:**
- Consumes: Task 2 safe provider plan, Task 3 stages/runtime/normalizer, existing `createAgentSession`, `createHttpAgentUpstream`, vault, xAI OAuth, redactor, and snapshot tools.
- Produces: `runPortableCodexSecurity(...)`, worker CLI entrypoint, durable stage telemetry and usage.

- [ ] **Step 1: Write RED runner boundary tests**

Cover:

- snapshot/connection/model/latest-probe/profile all revalidate before vault read;
- xAI OAuth exact tuple uses only the OAuth store; an impostor tuple reads neither OAuth nor vault;
- API-key routes read only their referenced vault bundle;
- each stage gets an isolated artifact root and exactly the four allowed tools;
- an unexpected artifact or missing expected artifact fails;
- malicious prior-state content remains base64-delimited untrusted data;
- abort/deadline during credential preflight or provider request settles without starting the next stage;
- late promise rejection is consumed;
- emitted logs/events contain no supplied fake secret;
- token usage aggregates input/cache/cache-write/output without inventing zeros when absent.

- [ ] **Step 2: Run RED runner tests**

Run:

```bash
pnpm --filter @csb/api exec node --import tsx --test \
  src/scanners/portable-codex-security-http-runner.test.ts \
  src/scanners/portable-codex-security-worker-support.test.ts
```

Expected: FAIL because runner/worker-support modules are missing.

- [ ] **Step 3: Implement preflight and session creation**

The runner dependency boundary must be injectable and secret-free:

```ts
export interface PortableCodexSecurityRunnerDependencies {
  getSnapshot(scanId: string): ScanConnectionSnapshot | null;
  getConnection(connectionId: string): StoredProviderConnection | null;
  getModel(connectionId: string, modelId: string): ProviderModel | null;
  getLatestCapabilityCheck(connectionId: string, modelId: string, protocol: ProviderProtocol): CapabilityReport | null;
  vault: Pick<CredentialVault, "get">;
  xaiOAuth?: Pick<XaiOAuthFlow, "getAccessToken">;
  createSession?: typeof createAgentSession;
  createUpstream?: typeof createHttpAgentUpstream;
  signal?: AbortSignal;
  now?: () => Date;
  redactor?: SecretRedactorRegistry;
}
```

Use one total deadline spanning metadata, credential resolution, all six stages, and cleanup. Pass only remaining time into each new session.

- [ ] **Step 4: Implement the stage loop and worker**

For every stage:

1. revalidate snapshot/connection/model/latest probe and profile identity;
2. verify the immutable snapshot hash;
3. create a private stage artifact directory;
4. start one constrained AgentSession;
5. persist redacted events and usage;
6. require exactly the expected artifact and structured completion;
7. reduce prior state to a bounded summary before the next stage.

The worker reads a `0600` JSON configuration, emits only closed safe errors to stderr, writes runtime atomically, and calls the normalizer only after the final schema validates.

- [ ] **Step 5: Run GREEN gates and commit**

Run Step 2 plus:

```bash
pnpm --filter @csb/api typecheck
git diff --check
```

Expected: all PASS.

Commit:

```bash
git add apps/api/src/scanners/portable-codex-security-http-runner.ts \
  apps/api/src/scanners/portable-codex-security-worker-support.ts \
  apps/api/src/scanners/portable-codex-security-worker.ts \
  apps/api/src/scanners/portable-codex-security-http-runner.test.ts \
  apps/api/src/scanners/portable-codex-security-worker-support.test.ts
git commit -m "feat: run Portable Codex Security sessions"
```

---

### Task 5: Launch, reconcile, progress, pricing, and recovery integration

**Files:**
- Create: `apps/api/src/scanners/portable-codex-security-reconcile.ts`
- Create: `apps/api/src/model-pricing.ts`
- Modify: `apps/api/src/scanners/launch.ts`
- Modify: `apps/api/src/runner.ts`
- Modify: `apps/api/src/ingest.ts`
- Modify: `apps/api/src/progress.ts`
- Test: `apps/api/src/scanner-adapters.test.ts`
- Test: `apps/api/src/runner-identity.test.ts`
- Create: `apps/api/src/runner-portable-codex-security-launch.test.ts`
- Create: `apps/api/src/scanners/portable-codex-security-reconcile.test.ts`
- Create: `apps/api/src/model-pricing.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4 profile plan/runtime/worker and existing runner telemetry/persistence.
- Produces: secret-free worker launch, `refreshPortableCodexSecurityRunFromDisk`, frozen cost estimate, restart-safe progress.

- [ ] **Step 1: Write RED launch/reconcile/pricing tests**

Prove:

- Portable launch JSON contains identifiers, profile, mode, paths and limits but no key/token/header/base URL;
- invalid/stale plan produces zero output writes and zero child starts;
- Native OpenAI launches are byte-for-byte unchanged;
- Portable initial run persists `executionProfile: "portable"` and nonzero recipe hash;
- a completed runtime hydrates findings/tokens/cost/progress;
- failed runtime with valid findings becomes `incomplete`; failed without findings remains `failed`;
- no usage or no pricing produces `cost: null`;
- catalog pricing computes input/cache/output components from frozen rates only;
- reopening after API restart recovers runtime and telemetry.

- [ ] **Step 2: Run RED integration tests**

Run:

```bash
pnpm --filter @csb/api exec node --import tsx --test \
  src/scanner-adapters.test.ts src/runner-identity.test.ts \
  src/runner-portable-codex-security-launch.test.ts \
  src/scanners/portable-codex-security-reconcile.test.ts \
  src/model-pricing.test.ts
```

Expected: FAIL because Portable launch/reconcile/pricing wiring is absent.

- [ ] **Step 3: Add the secret-free launcher**

Add `preparePortableCodexSecurityLaunch(...)` that writes `portable-codex-security-run.json` mode `0600`, starts the TypeScript worker with fixed argv, strips provider API-key variables from inherited env, and returns:

```ts
{
  engine: "codex-security",
  provider: providerKind,
  authMode: null,
  scannerVersion: PORTABLE_CODEX_SECURITY_PROFILE_VERSION,
  recipeHash: portableRecipeHash(configuration),
}
```

Change `ScannerLaunch.authMode` to `ScannerAuthMode | null`; all existing Native/Mantis/VulnHunter launchers keep their current non-null values. Portable uses `null`, while the immutable `execution.authKind` copied from the server-resolved connection is the public source of truth. This prevents xAI OAuth from being mislabeled as an API key.

- [ ] **Step 4: Wire runner, reconciliation, progress, and frozen pricing**

In `startScan`, choose Portable only when `selection.plan.execution.executionProfile === "portable"`; do not touch the existing Native branches. Register secrets only inside the worker after revalidation.

Add `model-pricing.ts`:

```ts
export function estimateCatalogUsageCost(
  usage: ScannerUsage,
  pricing: ModelPricing | null,
  capturedAt: string,
  modelId: string,
): ScanCost | null;
```

Return null unless usage was reported and at least input/output pricing exists. Calculate only components with an explicit catalog rate; cache-write usage with a null rate contributes no invented charge and remains separately visible. Reconcile Portable runtime from disk in runner close, ingest, detached polling, and `progressForStatus`.

- [ ] **Step 5: Run GREEN gates and commit**

Run Step 2 plus:

```bash
pnpm --filter @csb/api test
pnpm --filter @csb/api typecheck
git diff --check
```

Expected: all API tests PASS.

Commit:

```bash
git add apps/api/src/scanners/portable-codex-security-reconcile.ts \
  apps/api/src/model-pricing.ts apps/api/src/scanners/launch.ts apps/api/src/runner.ts \
  apps/api/src/ingest.ts apps/api/src/progress.ts apps/api/src/scanner-adapters.test.ts \
  apps/api/src/runner-identity.test.ts apps/api/src/runner-portable-codex-security-launch.test.ts \
  apps/api/src/scanners/portable-codex-security-reconcile.test.ts apps/api/src/model-pricing.test.ts
git commit -m "feat: integrate Portable Codex Security runs"
```

---

### Task 6: Profile-aware API, New Scan, detail, report, and comparator UI

**Required skill:** `frontend-design`

**Files:**
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/compare.ts`
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/lib/new-scan-routing.ts`
- Modify: `apps/web/src/pages/NewScanPage.tsx`
- Modify: `apps/web/src/pages/ScanDetailPage.tsx`
- Modify: `apps/web/src/pages/ScanReportPage.tsx`
- Modify: `apps/web/src/pages/ComparePage.tsx`
- Modify: `apps/web/src/pages/CompareReportPage.tsx`
- Modify: `apps/web/src/i18n.tsx`
- Test: `apps/api/src/compare.test.ts`
- Test: `apps/web/src/lib/new-scan-routing.test.ts`
- Test: `apps/web/src/lib/i18n.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2 and 5 public compatibility/provenance/run DTOs.
- Produces: localized profile identity, specific eligibility reasons, explicit Portable retry, profile-aware report/comparison.

- [ ] **Step 1: Write RED web/API behavior tests**

Add tests for:

- Auto request omits browser-authored provenance and submits only `executionProfilePreference: "auto"`;
- confirmation renders `Codex Security · Native` or `Codex Security · Portable` from server resolution;
- `codex_portable_capability_required/stale/failed` map to distinct localized copy;
- a failed Native run exposes `Retry with Portable` only when the server reports Portable eligible;
- retry keeps repository/engine/connection/model/mode/paths but sets preference Portable and never copies cost/provenance;
- compare result flags profile mismatch while preserving findings diff;
- all new i18n keys exist in five locales.

- [ ] **Step 2: Run RED UI/report tests**

Run:

```bash
pnpm --filter @csb/api exec node --import tsx --test src/compare.test.ts
pnpm --filter @csb/web test
```

Expected: FAIL because profile-aware helpers/copy do not exist.

- [ ] **Step 3: Implement profile-aware routing and confirmation**

Keep the current scanner cards and selection frames. Add a compact profile row to the authorization panel using existing primitives:

```tsx
<MetaCell
  label={t("newScan.executionProfile")}
  value={compatibility.selectedProfile === "native"
    ? t("newScan.profile.native")
    : t("newScan.profile.portable")}
/>
```

Do not add a manual profile switcher in this delivery. Keep reasoning effort entirely model-metadata driven.

- [ ] **Step 4: Add provenance and explicit retry to detail/report/compare**

Show profile, profile version, methodology ref, and capability-check ID in the Scan Detail profile tab and report execution metadata. Include profile in every compact scan identity string.

When profiles differ, render a localized comparison caveat; do not suppress the existing diff/ranking. Implement explicit Portable retry as a new scan request, never an in-place continuation.

- [ ] **Step 5: Add five-locale copy**

Add equivalent keys for:

```text
newScan.executionProfile
newScan.profile.native
newScan.profile.portable
newScan.profile.nativeReason
newScan.profile.portableReason
newScan.compatibilityPortableRequired
newScan.compatibilityPortableStale
newScan.compatibilityPortableFailed
scanDetail.retryPortable
scanDetail.retryPortableDescription
compare.profileMismatch
report.executionProfile
```

- [ ] **Step 6: Run GREEN gates and commit**

Run:

```bash
pnpm --filter @csb/api exec node --import tsx --test src/compare.test.ts
pnpm --filter @csb/web test
pnpm --filter @csb/web typecheck
pnpm --filter @csb/web build
git diff --check
```

Expected: all PASS; Vite's existing chunk-size warning is non-blocking.

Commit:

```bash
git add apps/api/src/app.ts apps/api/src/compare.ts apps/api/src/compare.test.ts \
  apps/web/src/api.ts apps/web/src/lib/new-scan-routing.ts \
  apps/web/src/lib/new-scan-routing.test.ts apps/web/src/pages/NewScanPage.tsx \
  apps/web/src/pages/ScanDetailPage.tsx apps/web/src/pages/ScanReportPage.tsx \
  apps/web/src/pages/ComparePage.tsx apps/web/src/pages/CompareReportPage.tsx \
  apps/web/src/i18n.tsx apps/web/src/lib/i18n.test.ts
git commit -m "feat: expose Codex Security execution profiles"
```

---

### Task 7: Provider matrix, end-to-end gates, visual QA, and documentation

**Files:**
- Modify: `apps/api/src/connection-preset-create-contract.test.ts`
- Modify: `apps/api/src/scan-start-api.test.ts`
- Modify: `apps/api/src/redaction.test.ts`
- Modify: `apps/web/src/lib/connection-presets.test.ts`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-11-provider-agnostic-codex-security-design.md`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: one closed regression matrix, full gates, responsive evidence, and operator documentation.

- [ ] **Step 1: Add the 18-preset regression matrix**

Iterate the shared `VISIBLE_CONNECTION_PRESETS` and assert every available route is either:

- Native eligible with an exact Native driver; or
- Portable eligible after a complete fresh fake probe; or
- blocked with one deterministic safe reason before vault/spawn.

Include explicit completion fixtures for OpenRouter, Gemini, DeepSeek, MiMo, Anthropic, MiniMax, xAI API/OAuth, and both custom protocols. Local/remote CLI routes remain fail-closed unless an existing bounded runner is explicitly supported.

- [ ] **Step 2: Add full launch/redaction E2E tests**

Start a fake Portable scan through the Hono API and assert:

- profile resolution appears in the initial run;
- six stages complete and findings populate Inspector data;
- telemetry survives route leave/reload;
- report and compare include provenance;
- supplied fake secrets never occur in config, log, event, error, finding, or response bodies;
- cancellation terminates without starting stage N+1.

- [ ] **Step 3: Run all deterministic gates**

Run:

```bash
pnpm --filter @csb/shared typecheck
pnpm --filter @csb/api test
pnpm --filter @csb/web test
pnpm typecheck
pnpm build
git diff --check
```

Expected: all PASS under Node 24.

- [ ] **Step 4: Run visual QA from the current checkout**

Start isolated API/Web processes from this branch, then validate:

- New Scan with Native and Portable at 390x844, 817x900, 1440x1000;
- no document-level horizontal overflow;
- profile labels, long German/French text, reasoning values, borders, and authorization panel fit;
- Scan Detail, Report, and Compare show provenance without overlap;
- keyboard focus and accessible names identify scanner/profile/retry actions;
- browser console has no product errors.

Store screenshots only under ignored `output/playwright/portable-codex-security/`; do not stage QA artifacts.

- [ ] **Step 5: Update documentation and commit**

Document Native versus Portable, capability probes, supported protocols, no-silent-fallback behavior, provenance, cost estimate semantics, and the explicit follow-up for official OpenRouter/Fireworks/Bedrock Native drivers.

Commit:

```bash
git add apps/api/src/connection-preset-create-contract.test.ts \
  apps/api/src/scan-start-api.test.ts apps/api/src/redaction.test.ts \
  apps/web/src/lib/connection-presets.test.ts README.md \
  docs/superpowers/specs/2026-08-11-provider-agnostic-codex-security-design.md
git commit -m "test: verify Portable Codex Security provider matrix"
```

---

## Execution Order and Parallel Sprints

1. Task 1 is the contract gate and lands first.
2. Tasks 2 and 3 run in parallel from Task 1 and receive independent reviews.
3. Task 4 starts after Tasks 2 and 3 are integrated.
4. Task 5 integrates the worker and runs the full API suite.
5. Task 6 may begin after Tasks 1 and 2, but its final wiring lands after Task 5.
6. Task 7 is the release gate.

Each task uses a dedicated `codex/` worktree branch, one implementer, one spec review, and one code-quality review. A task receives at most three review attempts; the primary agent takes over after that.

## Plan Self-Review

- **Spec coverage:** Native remains upstream; Portable covers capability-proven HTTP/xAI providers; provenance, cost, telemetry, Inspector, retry, localization, and visual QA are assigned.
- **Scope:** Additional Native provider drivers are explicitly split into a follow-up plan; this plan delivers non-OpenAI Codex Security scans through Portable.
- **Type consistency:** `executionProfile`, `profileVersion`, `methodologyRef`, `capabilityCheckId`, `connectionId`, `routeKind`, `protocol`, and `authKind` use the same names in snapshots, plans, runs, reports, and UI.
- **Security ordering:** compatibility and snapshot precede vault/network in Tasks 2, 4, and 5.
- **Auth provenance:** Portable launch uses legacy `authMode: null`; `execution.authKind` is authoritative and preserves OAuth/API/custom-header identity.
- **Pricing provenance:** cache-write usage is recorded, but its USD component remains absent until a provider catalog supplies an explicit rate.
- **No placeholders:** every task contains exact paths, contracts, RED/GREEN commands, and commit boundaries.
