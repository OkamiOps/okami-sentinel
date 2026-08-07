# Security Change Gate Local Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar um Security Change Gate local completo, com diff Git, política versionada, lifecycle contra baseline, preflight pelo runner existente e a interface Guardrails aprovada.

**Architecture:** Um novo pacote puro `@csb/gate-core` avalia findings e produz um `GateArtifact` determinístico. Um segundo pacote `@csb/gate-runtime` resolve Git e arquivos versionados sem depender da API. A API persiste `GateRun`, orquestra o scanner existente e expõe SSE; o frontend renderiza Portfolio Pipeline, Decision Graph, evidência e editor de política sem reavaliar decisões.

**Tech Stack:** TypeScript 5.8, Node.js 24.17, pnpm workspaces, Hono, better-sqlite3, React 19, React Router, Shadcn, DaisyUI, Tailwind CSS 4, node:test.

## Global Constraints

- Antes da Task 1, concluir e criar um checkpoint separado das mudanças já aceitas que hoje estão não commitadas e se sobrepõem a `apps/api/src/app.ts`, `apps/api/src/db.ts`, `apps/web/src/App.tsx`, `apps/web/src/api.ts`, `packages/shared/src/index.ts` e manifests.
- Não stagear `.superpowers/`; adicionar `.superpowers/` ao `.gitignore` no primeiro commit do plano.
- Usar Node.js `24.17.0` em instalação, testes, typecheck, build e runtime local.
- Não criar CSS global novo. Usar componentes Shadcn/DaisyUI, tokens existentes e utilities Tailwind.
- Antes da Task 8, ler e aplicar `frontend-design`, `impeccable` e `ui-ux-pro-max` conforme as instruções do workspace.
- Nenhum subprocesso usa `shell: true`; Git recebe arrays de argumentos.
- Nenhum token, secret ou caminho absoluto local entra em `GateArtifact` publicável.
- Falha operacional produz `error`; nunca `pass`.
- Sem baseline, o resultado é `bootstrap`; nunca `pass`.
- Seguir TDD: teste falhando, implementação mínima, teste passando, commit isolado.
- Não alterar, limpar ou resetar arquivos fora da tarefa atual.

---

## File Map

### Create

- `packages/gate-core/package.json` — workspace do domínio puro.
- `packages/gate-core/tsconfig.json` — configuração TypeScript.
- `packages/gate-core/src/default-policy.ts` — política inicial.
- `packages/gate-core/src/identity.ts` — identidade estável de findings.
- `packages/gate-core/src/evaluate.ts` — lifecycle, exceções e regras.
- `packages/gate-core/src/decision-graph.ts` — cadeia causal explicável.
- `packages/gate-core/src/artifact.ts` — artifact versionado.
- `packages/gate-core/src/index.ts` — API pública do pacote.
- `packages/gate-core/src/*.test.ts` — testes unitários do domínio.
- `packages/gate-runtime/package.json` — workspace dos adapters locais compartilhados.
- `packages/gate-runtime/tsconfig.json` — configuração TypeScript do runtime.
- `packages/gate-runtime/src/git-change-set.ts` — adapter Git sem shell.
- `packages/gate-runtime/src/guardrail-policy-file.ts` — leitura e escrita atômica da política.
- `packages/gate-runtime/src/guardrail-exceptions-file.ts` — leitura validada das exceções versionadas.
- `packages/gate-runtime/src/index.ts` — API pública do runtime.
- `packages/gate-runtime/src/*.test.ts` — testes dos adapters.
- `apps/api/src/gate-store.ts` — schema e CRUD SQLite.
- `apps/api/src/gate-orchestrator.ts` — coordenação de preflight, scan e avaliação.
- `apps/api/src/gate-events.ts` — assinaturas SSE e recuperação.
- `apps/api/src/guardrails.test.ts` — testes de API/orquestração com adapters falsos.
- `apps/web/src/lib/http.ts` — parser robusto de respostas HTTP.
- `apps/web/src/lib/guardrails.ts` — view models e deep links.
- `apps/web/src/lib/http.test.ts` — respostas vazias/não JSON.
- `apps/web/src/lib/guardrails.test.ts` — pipeline, graph e URL.
- `apps/web/src/components/guardrails/GateOutcomeBadge.tsx` — outcome semântico.
- `apps/web/src/components/guardrails/PortfolioPipeline.tsx` — lanes selecionáveis.
- `apps/web/src/components/guardrails/DecisionGraph.tsx` — cinco nós causais.
- `apps/web/src/components/guardrails/EvidenceTrace.tsx` — evidência do nó.
- `apps/web/src/components/guardrails/DecisionEquation.tsx` — baseline/current/rule/result.
- `apps/web/src/components/guardrails/index.ts` — exports da feature.
- `apps/web/src/pages/GuardrailsPage.tsx` — orquestra portfolio e gate selecionado.
- `apps/web/src/pages/GuardrailPolicyPage.tsx` — editor e simulador.

### Modify

- `.gitignore` — ignorar artifacts do companion.
- `package.json` — script agregado de testes e engine Node.
- `pnpm-lock.yaml` — novo workspace sem dependência externa de runtime.
- `packages/shared/src/index.ts` — anexar contratos Guardrails ao módulo compartilhado existente.
- `apps/api/package.json` — depender de `@csb/gate-core` e `@csb/gate-runtime`.
- `apps/api/src/app.ts` — endpoints Guardrails e SSE.
- `apps/api/src/lifecycle.ts` — reutilizar identidade do gate core.
- `apps/api/src/runner.ts` — exportar espera/cancelamento reutilizável sem duplicar processos.
- `apps/web/src/App.tsx` — navegação e rotas Guardrails.
- `apps/web/src/api.ts` — usar parser robusto e endpoints Guardrails.

---

### Task 1: Guardrails contracts and gate-core workspace

**Files:**
- Create: `packages/gate-core/package.json`
- Create: `packages/gate-core/tsconfig.json`
- Create: `packages/gate-core/src/default-policy.ts`
- Create: `packages/gate-core/src/default-policy.test.ts`
- Create: `packages/gate-core/src/index.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `package.json`
- Modify: `.gitignore`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `GuardrailRepository`, `GuardrailPolicy`, `GateRun`, `GateArtifact`, `GateDecision`, `ChangeSet`, `GateFindingDelta`, `DecisionGraph`, `defaultGuardrailPolicy()`.
- Consumes: `FindingSummary`, `FindingTriage`, `ScanCost`, `Severity` from `@csb/shared`.

- [ ] **Step 1: Create the workspace scaffold and add the failing default-policy test**

Create `packages/gate-core/package.json` with the exact manifest shown in Step 3, add the root-convention `tsconfig.json`, and create an empty `src/index.ts`. Run `pnpm install` under Node 24.17.0 so the workspace filter resolves. Do not create `default-policy.ts` yet. Then add the failing test:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { defaultGuardrailPolicy } from "./default-policy.js";

test("default policy blocks new or reopened critical and high findings", () => {
  const policy = defaultGuardrailPolicy();
  assert.equal(policy.schemaVersion, 1);
  assert.deepEqual(policy.protectedBranches, ["main"]);
  assert.deepEqual(policy.rules, [
    { severity: ["critical"], lifecycle: ["new", "reopened"], decision: "block" },
    { severity: ["high"], lifecycle: ["new", "reopened"], decision: "block" },
    { severity: ["high"], lifecycle: ["persistent"], decision: "review" },
  ]);
  assert.equal(policy.scan.maxCostUsd, 18);
});
```

- [ ] **Step 2: Run the test and confirm the implementation is missing**

Run: `pnpm --filter @csb/gate-core test`

Expected: FAIL because `default-policy.ts` does not exist; the test runner must report the test file rather than `No projects matched`.

- [ ] **Step 3: Add public types and the default policy**

Append these exact public unions and interfaces to the existing `packages/shared/src/index.ts`. Keep the current shared primitives in place; this task does not split or self-import the shared module:

```ts
export type GateSource = "local" | "github";
export type GateStatus = "queued" | "resolving" | "scanning" | "evaluating" | "publishing" | "completed" | "cancelled" | "error";
export type GateOutcome = "no_changes" | "bootstrap" | "pass" | "warning" | "blocked" | "error";
export type GateFindingLifecycle = "new" | "reopened" | "persistent" | "fixed";
export type GateRuleDecision = "block" | "review";
export type GitHubConclusion = "success" | "neutral" | "failure" | "action_required";

export interface GuardrailRule {
  severity: Severity[];
  lifecycle: GateFindingLifecycle[];
  decision: GateRuleDecision;
}

export interface GuardrailPolicy {
  schemaVersion: 1;
  protectedBranches: string[];
  scope: { mode: "changed" | "repository"; maxChangedPaths: number; fallback: "repository" | "error" };
  scan: { model: string; effort: string; mode: "standard" | "deep"; maxCostUsd: number };
  rules: GuardrailRule[];
}

export interface ChangeSetFile {
  status: "added" | "modified" | "renamed" | "deleted";
  path: string;
  previousPath: string | null;
  additions: number | null;
  deletions: number | null;
}

export interface ChangeSet {
  baseRef: string;
  headRef: string;
  baseSha: string;
  headSha: string;
  files: ChangeSetFile[];
  scanPaths: string[];
  scopeMode: "changed" | "repository";
  fallbackReason: string | null;
}

export interface GuardrailException {
  findingIdentity: string;
  reason: string;
  owner: string;
  createdAt: string;
  expiresAt: string;
  branches: string[];
  ruleIndexes: number[];
}

export interface GateFindingDelta extends FindingSummary {
  identity: string;
  lifecycle: GateFindingLifecycle;
  triage: FindingTriage;
  exception: GuardrailException | null;
  sourceScanId: string;
}

export interface DecisionGraphNode {
  id: string;
  kind: "changeset" | "surface" | "signal" | "rule" | "verdict";
  label: string;
  value: string;
  detail: string | null;
  tone: "neutral" | "good" | "warning" | "risk";
  findingIdentity: string | null;
}

export interface DecisionGraph { nodes: DecisionGraphNode[]; selectedNodeId: string; }

export interface GateViolation {
  findingIdentity: string;
  ruleIndex: number;
  decision: GateRuleDecision;
  reason: string;
}

export interface GateDecision {
  outcome: GateOutcome;
  summary: string;
  violations: GateViolation[];
  warnings: GateViolation[];
  exceptionsApplied: string[];
  githubConclusion: GitHubConclusion;
  decisionGraph: DecisionGraph;
}

export interface GateArtifact {
  schemaVersion: 1;
  gateId: string;
  repository: { key: string; owner: string | null; name: string; defaultBranch: string };
  source: GateSource;
  changeSet: ChangeSet;
  policy: GuardrailPolicy;
  scan: { id: string | null; cost: ScanCost | null; status: string };
  baselineCommit: string | null;
  findings: GateFindingDelta[];
  decision: GateDecision;
  versions: { gateCore: string; scanner: string | null };
  createdAt: string;
}

export interface GateRun {
  id: string;
  repositoryKey: string;
  repositoryPath: string;
  source: GateSource;
  baseRef: string;
  headRef: string;
  pullRequestNumber: number | null;
  scanId: string | null;
  status: GateStatus;
  outcome: GateOutcome | null;
  policyVersion: number;
  baselineCommit: string | null;
  artifactPath: string | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  estimatedUsd: number;
}

export type RepositoryGitHubStatus = "not_configured" | "not_checked" | "ready" | "action_required";

export interface GuardrailRepository {
  repositoryKey: string;
  repositoryPath: string;
  displayName: string;
  defaultBranch: string;
  remoteOwner: string | null;
  remoteName: string | null;
  enabled: boolean;
  policyPath: string;
  lastGateId: string | null;
  githubStatus: RepositoryGitHubStatus;
}
```

The `packages/gate-core/package.json` scaffold created in Step 1 must contain exactly:

```json
{
  "name": "@csb/gate-core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "tsx --test src/*.test.ts",
    "typecheck": "tsc --noEmit",
    "build": "tsc --noEmit"
  },
  "dependencies": { "@csb/shared": "workspace:*" },
  "devDependencies": { "@types/node": "^22.15.32", "tsx": "^4.23.1", "typescript": "^5.8.3" }
}
```

Create `default-policy.ts`:

```ts
import type { GuardrailPolicy } from "@csb/shared";

export function defaultGuardrailPolicy(): GuardrailPolicy {
  return {
    schemaVersion: 1,
    protectedBranches: ["main"],
    scope: { mode: "changed", maxChangedPaths: 50, fallback: "repository" },
    scan: { model: "gpt-5.6-sol", effort: "high", mode: "standard", maxCostUsd: 18 },
    rules: [
      { severity: ["critical"], lifecycle: ["new", "reopened"], decision: "block" },
      { severity: ["high"], lifecycle: ["new", "reopened"], decision: "block" },
      { severity: ["high"], lifecycle: ["persistent"], decision: "review" },
    ],
  };
}
```

Export it from `packages/gate-core/src/index.ts`. Add `"engines": { "node": ">=24 <25" }` and `"test": "pnpm -r --if-present test"` to the root `package.json`. Add `.superpowers/` to `.gitignore`. Run `pnpm install` under Node 24.17.0 again only if these manifest changes alter the lockfile.

- [ ] **Step 4: Run package and workspace gates**

Run:

```bash
pnpm --filter @csb/gate-core test
pnpm --filter @csb/gate-core typecheck
pnpm --filter @csb/shared typecheck
```

Expected: all commands exit 0; one policy test passes.

- [ ] **Step 5: Commit the contracts**

```bash
git add .gitignore package.json pnpm-lock.yaml packages/shared/src packages/gate-core
git commit -m "feat: add guardrail contracts and gate core workspace"
```

---

### Task 2: Deterministic lifecycle and policy evaluator

**Files:**
- Create: `packages/gate-core/src/identity.ts`
- Create: `packages/gate-core/src/evaluate.ts`
- Create: `packages/gate-core/src/evaluate.test.ts`
- Modify: `packages/gate-core/src/index.ts`
- Modify: `apps/api/src/lifecycle.ts`
- Modify: `apps/api/src/lifecycle.test.ts`

**Interfaces:**
- Consumes: `GuardrailPolicy`, current/baseline/historical findings, triage, exceptions and `ChangeSet`.
- Produces: `findingIdentity(finding)`, `classifyGateFindings(input)`, `evaluateGate(input)`.

- [ ] **Step 1: Write the evaluator matrix tests**

Test these exact cases in `evaluate.test.ts`:

```ts
test("returns no_changes without a scan", () => {
  const result = evaluateGate(input({ changeSet: changeSet([]) }));
  assert.equal(result.decision.outcome, "no_changes");
  assert.equal(result.deltas.length, 0);
});

test("returns bootstrap when no baseline exists", () => {
  const result = evaluateGate(input({ baselineFindings: null }));
  assert.equal(result.decision.outcome, "bootstrap");
  assert.equal(result.decision.githubConclusion, "neutral");
});

test("blocks a reopened high finding", () => {
  const high = finding("stable-xss", "high");
  const result = evaluateGate(input({ currentFindings: [high], baselineFindings: [], historicalFindings: [high] }));
  assert.equal(result.deltas[0]?.lifecycle, "reopened");
  assert.equal(result.decision.outcome, "blocked");
  assert.equal(result.decision.githubConclusion, "failure");
});

test("warns for a persistent high finding", () => {
  const high = finding("stable-xss", "high");
  const result = evaluateGate(input({ currentFindings: [high], baselineFindings: [high] }));
  assert.equal(result.deltas[0]?.lifecycle, "persistent");
  assert.equal(result.decision.outcome, "warning");
});

test("does not block an active exception", () => {
  const high = finding("stable-xss", "high");
  const result = evaluateGate(input({
    currentFindings: [high],
    baselineFindings: [],
    historicalFindings: [high],
    exceptions: [{ findingIdentity: findingIdentity(high), reason: "Migration window", owner: "marcos", createdAt: "2026-08-01T00:00:00Z", expiresAt: "2026-08-30T00:00:00Z", branches: ["main"], ruleIndexes: [] }],
    now: "2026-08-07T00:00:00Z",
  }));
  assert.equal(result.decision.outcome, "pass");
  assert.equal(result.decision.exceptionsApplied.length, 1);
});

test("blocks when the matching exception is expired", () => {
  const high = finding("stable-xss", "high");
  const result = evaluateGate(input({
    currentFindings: [high],
    baselineFindings: [],
    historicalFindings: [high],
    exceptions: [{ findingIdentity: findingIdentity(high), reason: "Expired window", owner: "marcos", createdAt: "2026-07-01T00:00:00Z", expiresAt: "2026-07-31T00:00:00Z", branches: ["main"], ruleIndexes: [] }],
    now: "2026-08-07T00:00:00Z",
  }));
  assert.equal(result.decision.outcome, "blocked");
  assert.equal(result.decision.exceptionsApplied.length, 0);
});

test("keeps false-positive findings in the artifact without blocking", () => {
  const high = finding("stable-xss", "high");
  const result = evaluateGate(input({
    currentFindings: [high],
    baselineFindings: [],
    triageByIdentity: new Map([[findingIdentity(high), { status: "false_positive", note: "Reviewed", updatedAt: "2026-08-07T00:00:00Z" }]]),
  }));
  assert.equal(result.deltas.length, 1);
  assert.equal(result.decision.outcome, "pass");
});
```

- [ ] **Step 2: Run the evaluator test and verify failure**

Run: `pnpm --filter @csb/gate-core test`

Expected: FAIL because `evaluateGate` and `findingIdentity` are not exported.

- [ ] **Step 3: Implement identity, lifecycle and decision priority**

Implement this public boundary:

```ts
export interface EvaluateGateInput {
  policy: GuardrailPolicy;
  branch: string;
  changeSet: ChangeSet;
  currentFindings: FindingSummary[];
  baselineFindings: FindingSummary[] | null;
  historicalFindings: FindingSummary[];
  triageByIdentity: ReadonlyMap<string, FindingTriage>;
  exceptions: GuardrailException[];
  sourceScanId: string;
  now: string;
}

export interface EvaluateGateResult {
  deltas: GateFindingDelta[];
  decision: Omit<GateDecision, "decisionGraph">;
}
```

Use the following outcome algorithm in `evaluateGate`:

```ts
if (input.changeSet.files.length === 0) return noChangesResult();
if (input.baselineFindings === null) return bootstrapResult(input);

const deltas = classifyGateFindings(input);
const violations: GateViolation[] = [];
const warnings: GateViolation[] = [];
const exceptionsApplied: string[] = [];

for (const finding of deltas) {
  if (finding.lifecycle === "fixed") continue;
  if (finding.triage.status === "false_positive") continue;
  input.policy.rules.forEach((rule, ruleIndex) => {
    if (!rule.severity.includes(finding.severity) || !rule.lifecycle.includes(finding.lifecycle)) return;
    const activeException = input.exceptions.find((exception) =>
      exception.findingIdentity === finding.identity &&
      exception.createdAt <= input.now && input.now < exception.expiresAt &&
      (exception.branches.includes(input.branch) || exception.ruleIndexes.includes(ruleIndex)),
    );
    if (activeException) {
      finding.exception ??= activeException;
      if (!exceptionsApplied.includes(finding.identity)) exceptionsApplied.push(finding.identity);
      return;
    }
    const row = { findingIdentity: finding.identity, ruleIndex, decision: rule.decision, reason: `${finding.severity}/${finding.lifecycle}` };
    (rule.decision === "block" ? violations : warnings).push(row);
  });
}

const outcome = violations.length ? "blocked" : warnings.length ? "warning" : "pass";
```

Map GitHub conclusions with a total function:

```ts
export function githubConclusion(outcome: GateOutcome): GitHubConclusion {
  if (outcome === "pass" || outcome === "no_changes") return "success";
  if (outcome === "warning" || outcome === "bootstrap") return "neutral";
  if (outcome === "blocked") return "failure";
  return "action_required";
}
```

Move the stable fingerprint logic from `apps/api/src/lifecycle.ts` into `packages/gate-core/src/identity.ts`. Keep `apps/api/src/lifecycle.ts` as a compatibility wrapper that imports and re-exports `findingIdentity`; existing regression tests must remain green.

- [ ] **Step 4: Run core and regression tests**

Run:

```bash
pnpm --filter @csb/gate-core test
pnpm --filter @csb/api test
```

Expected: evaluator matrix passes and all existing API tests remain green.

- [ ] **Step 5: Commit the evaluator**

```bash
git add packages/gate-core/src apps/api/src/lifecycle.ts apps/api/src/lifecycle.test.ts
git commit -m "feat: evaluate guardrail policies deterministically"
```

---

### Task 3: Decision Graph and GateArtifact

**Files:**
- Create: `packages/gate-core/src/decision-graph.ts`
- Create: `packages/gate-core/src/decision-graph.test.ts`
- Create: `packages/gate-core/src/artifact.ts`
- Create: `packages/gate-core/src/artifact.test.ts`
- Modify: `packages/gate-core/src/index.ts`

**Interfaces:**
- Consumes: `EvaluateGateResult`, repository identity, scan summary and version strings.
- Produces: `buildDecisionGraph(changeSet, deltas, decision)`, `buildGateArtifact(input)`, `buildOperationalErrorArtifact(input)` and `parseGateArtifact(value)`.

- [ ] **Step 1: Write graph and artifact tests**

```ts
test("builds five causal nodes for the primary blocking violation", () => {
  const graph = buildDecisionGraph(blockedFixture());
  assert.deepEqual(graph.nodes.map((node) => node.kind), ["changeset", "surface", "signal", "rule", "verdict"]);
  assert.equal(graph.nodes[2]?.value, "Stored XSS reaberto");
  assert.equal(graph.nodes[4]?.value, "BLOCKED");
  assert.equal(graph.selectedNodeId, graph.nodes[2]?.id);
});

test("does not invent a surface when evidence is absent", () => {
  const graph = buildDecisionGraph(passFixture({ category: null, primaryPath: null }));
  assert.equal(graph.nodes[1]?.value, "Não determinado");
  assert.equal(graph.nodes[1]?.tone, "neutral");
});

test("creates a schema v1 artifact without a local path", () => {
  const artifact = buildGateArtifact(artifactInput());
  assert.equal(artifact.schemaVersion, 1);
  assert.equal(JSON.stringify(artifact).includes("/Users/"), false);
  assert.equal(artifact.decision.decisionGraph.nodes.length, 5);
});

test("creates an action_required artifact for an operational failure", () => {
  const artifact = buildOperationalErrorArtifact(errorArtifactInput("scanner unavailable"));
  assert.equal(artifact.decision.outcome, "error");
  assert.equal(artifact.decision.githubConclusion, "action_required");
  assert.equal(artifact.decision.decisionGraph.nodes.at(-1)?.value, "ERROR");
});

test("rejects an artifact from a future schema", () => {
  assert.throws(() => parseGateArtifact({ ...buildGateArtifact(artifactInput()), schemaVersion: 2 }), /GateArtifact schema 2 não suportado/);
});
```

- [ ] **Step 2: Run tests and verify missing builders**

Run: `pnpm --filter @csb/gate-core test`

Expected: FAIL because graph and artifact builders do not exist.

- [ ] **Step 3: Implement a fixed five-stage graph**

Use the primary blocking violation, then primary warning, then first non-fixed delta. Build exactly five nodes. Use `finding.category ?? finding.primaryPath ?? "Não determinado"` for surface and never infer dependencies. Use stable IDs `changeset`, `surface`, `signal`, `rule`, `verdict`.

Implement `buildGateArtifact` as a pure object constructor that:

- adds `schemaVersion: 1`;
- copies only repository key, owner, name and default branch;
- embeds the effective policy and change set;
- embeds deltas and decision;
- uses the passed ISO timestamp;
- throws if `repository.key` or `repository.name` is empty;
- throws if `changeSet.baseSha` or `changeSet.headSha` is empty.

The constructor input must not contain `repositoryPath`.

`buildOperationalErrorArtifact` uses the same public-safe repository/change-set envelope, leaves findings empty, records only a sanitized operational summary, and always emits `outcome: "error"` plus `githubConclusion: "action_required"`. `parseGateArtifact` performs complete manual runtime validation for schema v1, rejects future schemas, rejects malformed graph nodes and returns a typed `GateArtifact`; it is the only parser used later for local or GitHub baselines.

- [ ] **Step 4: Run core test and typecheck**

Run:

```bash
pnpm --filter @csb/gate-core test
pnpm --filter @csb/gate-core typecheck
```

Expected: all graph/artifact tests pass.

- [ ] **Step 5: Commit graph and artifact**

```bash
git add packages/gate-core/src
git commit -m "feat: explain gate decisions with causal artifacts"
```

---

### Task 4: Shared Git and versioned configuration runtime

**Files:**
- Create: `packages/gate-runtime/package.json`
- Create: `packages/gate-runtime/tsconfig.json`
- Create: `packages/gate-runtime/src/git-change-set.ts`
- Create: `packages/gate-runtime/src/git-change-set.test.ts`
- Create: `packages/gate-runtime/src/guardrail-policy-file.ts`
- Create: `packages/gate-runtime/src/guardrail-policy-file.test.ts`
- Create: `packages/gate-runtime/src/guardrail-exceptions-file.ts`
- Create: `packages/gate-runtime/src/guardrail-exceptions-file.test.ts`
- Create: `packages/gate-runtime/src/index.ts`
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: repository path, base/head refs, `GuardrailPolicy` and versioned exception JSON.
- Produces: `resolveChangeSet(input, runner?)`, `readGuardrailPolicy(repoPath)`, `writeGuardrailPolicy(repoPath, policy)`, `readGuardrailExceptions(repoPath)`.

- [ ] **Step 1: Create the runtime scaffold and write parser/configuration tests**

Create `packages/gate-runtime/package.json` with the exact manifest shown in Step 3, add the root-convention `tsconfig.json`, and create an empty `src/index.ts`. Run `pnpm install` under Node 24.17.0 so the workspace filter resolves. Do not create any adapter implementation yet. Then add the failing tests:

```ts
test("parses modified, deleted and renamed paths from nul-separated git output", () => {
  assert.deepEqual(parseNameStatusZ("M\0src/a.ts\0D\0src/old.ts\0R100\0src/from.ts\0src/to.ts\0"), [
    { status: "modified", path: "src/a.ts", previousPath: null },
    { status: "deleted", path: "src/old.ts", previousPath: null },
    { status: "renamed", path: "src/to.ts", previousPath: "src/from.ts" },
  ]);
});

test("falls back to repository scope above the path ceiling", async () => {
  const result = await resolveChangeSet({ repositoryPath: "/repo", baseRef: "main", headRef: "HEAD", maxChangedPaths: 2, fallback: "repository" }, fakeGit(3));
  assert.equal(result.scopeMode, "repository");
  assert.deepEqual(result.scanPaths, []);
  assert.match(result.fallbackReason ?? "", /3 changed paths/);
});

test("writes and reads schema v1 policy atomically", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "csb-policy-"));
  writeGuardrailPolicy(repo, defaultGuardrailPolicy());
  assert.deepEqual(readGuardrailPolicy(repo), defaultGuardrailPolicy());
  assert.equal(fs.existsSync(path.join(repo, ".csb", "guardrails.json.tmp")), false);
});

test("returns the default policy without writing when the policy file is absent", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "csb-policy-missing-"));
  assert.deepEqual(readGuardrailPolicy(repo), defaultGuardrailPolicy());
  assert.equal(fs.existsSync(path.join(repo, ".csb", "guardrails.json")), false);
});

test("reads versioned exceptions and rejects incomplete entries", () => {
  const repo = tempRepoWithExceptions({
    schemaVersion: 1,
    exceptions: [{
      findingIdentity: "finding-1",
      reason: "Migração com prazo definido",
      owner: "marcos",
      createdAt: "2026-08-01T00:00:00Z",
      expiresAt: "2026-08-30T00:00:00Z",
      branches: ["main"],
      ruleIndexes: [],
    }],
  });
  assert.equal(readGuardrailExceptions(repo)[0]?.findingIdentity, "finding-1");
  assert.throws(() => readGuardrailExceptions(tempRepoWithExceptions({ schemaVersion: 1, exceptions: [{ reason: "missing identity" }] })), /exceptions\[0\]\.findingIdentity/);
});
```

- [ ] **Step 2: Run runtime tests and verify failure**

Run: `pnpm --filter @csb/gate-runtime test`

Expected: FAIL because the adapter modules do not exist; the test runner must report the test files rather than `No projects matched`.

- [ ] **Step 3: Create the runtime workspace and implement adapters without a shell**

The `packages/gate-runtime/package.json` scaffold created in Step 1 must contain exactly:

```json
{
  "name": "@csb/gate-runtime",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "tsx --test src/*.test.ts",
    "typecheck": "tsc --noEmit",
    "build": "tsc --noEmit"
  },
  "dependencies": {
    "@csb/gate-core": "workspace:*",
    "@csb/shared": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^22.15.32",
    "tsx": "^4.23.1",
    "typescript": "^5.8.3"
  }
}
```

Use the root TypeScript conventions in `packages/gate-runtime/tsconfig.json`, export every public adapter from `src/index.ts`, and add both `@csb/gate-core` and `@csb/gate-runtime` as workspace dependencies in `apps/api/package.json`.

Run `pnpm install` under Node 24.17.0 immediately after creating the workspace so `pnpm-lock.yaml` records `@csb/gate-runtime` before its tests run.

Define:

```ts
export type GitRunner = (args: string[], cwd: string) => Promise<string>;

const defaultGitRunner: GitRunner = async (args, cwd) => {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  return stdout;
};
```

Resolve root and SHAs with:

```ts
await run(["rev-parse", "--show-toplevel"], repositoryPath);
const baseSha = (await run(["rev-parse", "--verify", `${baseRef}^{commit}`], repositoryPath)).trim();
const headSha = (await run(["rev-parse", "--verify", `${headRef}^{commit}`], repositoryPath)).trim();
const status = await run(["diff", "--name-status", "--find-renames", "-z", `${baseSha}...${headSha}`], repositoryPath);
```

Reject any returned path that is absolute or resolves outside the Git root. Deleted paths remain in `files` but not `scanPaths`. If changed paths exceed the ceiling, apply the configured fallback.

When `.csb/guardrails.json` is absent, return `defaultGuardrailPolicy()` without creating a file; the first confirmed save creates it. Implement manual schema validation for policy: exact `schemaVersion: 1`, non-empty branches, finite positive `maxCostUsd`, positive `maxChangedPaths`, allowed `severity`, `lifecycle` and `decision` values. Throw `GuardrailPolicyError` with a field path such as `scan.maxCostUsd`.

Read `.csb/guardrails-exceptions.json` as `{ schemaVersion: 1, exceptions: GuardrailException[] }`. Normalize an omitted `branches` or `ruleIndexes` field to `[]`, but require at least one non-empty target list. Missing file returns `[]`; malformed JSON, future schema, missing identity/reason/owner/timestamps, invalid ISO timestamps, negative rule indexes or no branch/rule target throws `GuardrailExceptionsError` with the failing field path. Expiration and target applicability remain domain decisions in `@csb/gate-core`; the runtime only parses and validates.

Write to `.csb/guardrails.json.tmp`, `fsync`, then rename to `.csb/guardrails.json`.

- [ ] **Step 4: Run adapter tests**

Run:

```bash
pnpm --filter @csb/gate-runtime test
pnpm --filter @csb/gate-runtime typecheck
pnpm --filter @csb/api typecheck
```

Expected: all Git/policy/exception tests pass and the API resolves both internal packages.

- [ ] **Step 5: Commit adapters**

```bash
git add packages/gate-runtime apps/api/package.json pnpm-lock.yaml
git commit -m "feat: resolve git changesets and guardrail policies"
```

---

### Task 5: SQLite GateRun store

**Files:**
- Create: `apps/api/src/gate-store.ts`
- Create: `apps/api/src/gate-store.test.ts`

**Interfaces:**
- Consumes: `Database.Database`, `GateRun`, enrolled repository data.
- Produces: `ensureGateSchema`, `upsertGuardrailRepository`, `listGuardrailRepositories`, `insertGateRun`, `updateGateRun`, `getGateRun`, `listGateRuns`, `appendGateEvent`, `listGateEvents`.

- [ ] **Step 1: Write an in-memory CRUD test**

```ts
test("persists repositories and gate runs without changing scan tables", () => {
  const db = new Database(":memory:");
  ensureGateSchema(db);
  upsertGuardrailRepository(repositoryFixture(), db);
  insertGateRun(gateRunFixture(), db);
  assert.equal(listGuardrailRepositories(db)[0]?.repositoryKey, "github.com/okami/csb");
  assert.equal(getGateRun("gate-1", db)?.status, "queued");
  updateGateRun("gate-1", { status: "completed", outcome: "pass", completedAt: "2026-08-07T10:00:00Z" }, db);
  assert.equal(getGateRun("gate-1", db)?.outcome, "pass");
  appendGateEvent("gate-1", { sequence: 1, type: "status", payload: { status: "completed" }, createdAt: "2026-08-07T10:00:00Z" }, db);
  assert.deepEqual(listGateEvents("gate-1", db).map((event) => event.sequence), [1]);
  assert.deepEqual(db.prepare("SELECT count(*) count FROM sqlite_master WHERE name = 'runs'").get(), { count: 0 });
});
```

- [ ] **Step 2: Run test and verify the schema is missing**

Run: `pnpm --filter @csb/api test`

Expected: FAIL because `gate-store.ts` does not exist.

- [ ] **Step 3: Implement additive tables and injected database access**

Create only these tables:

```sql
CREATE TABLE IF NOT EXISTS guardrail_repositories (
  repository_key TEXT PRIMARY KEY,
  repository_path TEXT NOT NULL,
  display_name TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  remote_owner TEXT,
  remote_name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  policy_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gate_runs (
  id TEXT PRIMARY KEY,
  repository_key TEXT NOT NULL,
  repository_path TEXT NOT NULL,
  source TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  head_ref TEXT NOT NULL,
  pull_request_number INTEGER,
  scan_id TEXT,
  status TEXT NOT NULL,
  outcome TEXT,
  policy_version INTEGER NOT NULL,
  baseline_commit TEXT,
  artifact_path TEXT,
  error TEXT,
  estimated_usd REAL NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS gate_runs_by_repository_started
  ON gate_runs(repository_key, started_at DESC);

CREATE TABLE IF NOT EXISTS gate_events (
  gate_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (gate_id, sequence)
);
```

Every function accepts an optional `Database.Database`; default to `getDb()`. Call `ensureGateSchema` before each public operation. Map booleans and nullable fields explicitly. `listGuardrailRepositories` derives `lastGateId` from the newest `gate_runs.started_at`; before live GitHub diagnostics it returns `not_configured` when no remote exists and `not_checked` when owner/name exist. Serialize only bounded status/progress summaries in `payload_json`; scanner logs remain in the scan artifact and are not duplicated in SQLite.

- [ ] **Step 4: Run store tests and typecheck**

Run:

```bash
pnpm --filter @csb/api test
pnpm --filter @csb/api typecheck
```

Expected: in-memory CRUD and all existing tests pass.

- [ ] **Step 5: Commit store**

```bash
git add apps/api/src/gate-store.ts apps/api/src/gate-store.test.ts
git commit -m "feat: persist local guardrail runs"
```

---

### Task 6: Local gate orchestrator, cancellation and recovery

**Files:**
- Create: `apps/api/src/gate-events.ts`
- Create: `apps/api/src/gate-orchestrator.ts`
- Create: `apps/api/src/gate-orchestrator.test.ts`
- Modify: `apps/api/src/runner.ts`
- Modify: `apps/api/src/config.ts`

**Interfaces:**
- Consumes: `resolveChangeSet`, policy file, store, scan runner, findings reader and gate core.
- Produces: `startLocalGate(request, deps?)`, `cancelGate(gateId)`, `subscribeGate(gateId, listener)`, `getGateArtifact(gateId)`.

- [ ] **Step 1: Write orchestrator tests with injected adapters**

Cover exact cases:

```ts
test("finishes no_changes without starting a scan", async () => {
  const deps = fakeDeps({ changeSet: changeSet([]) });
  const gate = await startLocalGate(request(), deps);
  await deps.finished(gate.id);
  assert.equal(deps.startScanCalls, 0);
  assert.equal(deps.store.get(gate.id)?.outcome, "no_changes");
});

test("passes changed paths and cost envelope to the scanner", async () => {
  const deps = fakeDeps({ changeSet: changeSet(["src/a.ts", "src/b.ts"]), scanStatus: "completed" });
  const gate = await startLocalGate(request(), deps);
  await deps.finished(gate.id);
  assert.deepEqual(deps.lastScanRequest?.paths, ["src/a.ts", "src/b.ts"]);
  assert.equal(deps.lastScanRequest?.maxCostUsd, 18);
});

test("records engine failure as error instead of pass", async () => {
  const deps = fakeDeps({ scanStatus: "failed" });
  const gate = await startLocalGate(request(), deps);
  await deps.finished(gate.id);
  assert.equal(deps.store.get(gate.id)?.outcome, "error");
});

test("cancels the linked scan", async () => {
  const deps = fakeDeps({ holdScan: true });
  const gate = await startLocalGate(request(), deps);
  assert.equal(cancelGate(gate.id, deps), true);
  assert.equal(deps.cancelledScanId, "scan-1");
});
```

- [ ] **Step 2: Run tests and verify missing orchestration**

Run: `pnpm --filter @csb/api test`

Expected: FAIL because gate orchestrator and events do not exist.

- [ ] **Step 3: Export a reusable scan completion promise**

Add to `runner.ts`:

```ts
export function waitForScan(scanId: string): Promise<ScanRun> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => undefined;
    unsubscribe = subscribe(scanId, (event) => {
      if (event.type === "done" && event.scan) {
        unsubscribe();
        resolve(event.scan);
      } else if (event.type === "error") {
        unsubscribe();
        reject(new Error(event.message ?? "Scan falhou"));
      }
    });
  });
}
```

Keep the initialization order above so a synchronous subscription callback cannot access an uninitialized function.

- [ ] **Step 4: Implement the orchestrator state machine**

`startLocalGate` must return the persisted queued GateRun immediately and continue asynchronously through:

```text
queued → resolving → scanning → evaluating → completed
```

Use one guarded `runGate(gateId, deps)` promise per active gate. Persist every transition through `appendGateEvent` before emitting the matching SSE event. Store artifacts under `GATES_DIR/<gateId>/csb-gate-result.json` using a temporary file and rename. On any thrown error after the change set is known, build and persist a sanitized `buildOperationalErrorArtifact`, then persist `{ status: "error", outcome: "error", error: message, completedAt }` and emit an error event. If resolution fails before a public-safe change set exists, persist the error state/event without fabricating SHAs or an artifact.

For local baseline input:

- read the explicit repository baseline from existing `repository_baselines`;
- read current and baseline findings through `readFindingsFile`;
- collect older completed findings for reopened classification;
- read triage by stable identity;
- read active exceptions from the versioned exception file;
- pass all data to `evaluateGate`, then `buildDecisionGraph` and `buildGateArtifact`.

Recovery: when `subscribeGate` sees a persisted gate in `scanning` with a linked active/detached scan, attach once through `waitForScan` and continue evaluation. Never start a second scan.

- [ ] **Step 5: Run orchestration tests**

Run:

```bash
pnpm --filter @csb/api test
pnpm --filter @csb/api typecheck
```

Expected: no_changes, path forwarding, failure and cancellation tests pass.

- [ ] **Step 6: Commit orchestration**

```bash
git add apps/api/src/gate-events.ts apps/api/src/gate-orchestrator.ts apps/api/src/gate-orchestrator.test.ts apps/api/src/runner.ts apps/api/src/config.ts
git commit -m "feat: orchestrate local security change gates"
```

---

### Task 7: Guardrails HTTP API and robust client errors

**Files:**
- Create: `apps/api/src/guardrails.test.ts`
- Create: `apps/web/src/lib/http.ts`
- Create: `apps/web/src/lib/http.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/web/src/api.ts`

**Interfaces:**
- Consumes: store, orchestrator and policy adapter.
- Produces: REST/SSE endpoints from the spec and `parseApiResponse<T>(response)`.

- [ ] **Step 1: Write Hono route and response parser tests**

```ts
test("POST /guardrails/gates returns 202 with a queued gate", async () => {
  const response = await testApp.request("/guardrails/gates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repositoryKey: "github.com/okami/csb", baseRef: "main", headRef: "HEAD" }),
  });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).gate.status, "queued");
});

test("describes an empty HTTP 500 response", async () => {
  await assert.rejects(
    () => parseApiResponse(new Response("", { status: 500 })),
    /API indisponível \(HTTP 500\)/,
  );
});

test("uses a structured API error", async () => {
  await assert.rejects(
    () => parseApiResponse(new Response(JSON.stringify({ error: "Referência main não encontrada" }), { status: 400 })),
    /Referência main não encontrada/,
  );
});

test("policy simulation reports an expired exception and does not apply it", async () => {
  const response = await testApp.request("/guardrails/repositories/github.com%2Fokami%2Fcsb/policy/simulate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gateId: "gate-1", policy: defaultGuardrailPolicy(), now: "2026-08-07T00:00:00Z" }),
  });
  const body = await response.json();
  assert.equal(body.decision.exceptionsApplied.length, 0);
  assert.equal(body.configurationErrors[0]?.field, "exceptions[0].expiresAt");
});
```

- [ ] **Step 2: Run API and web tests and verify failure**

Run:

```bash
pnpm --filter @csb/api test
pnpm --filter @csb/web test
```

Expected: FAIL because routes and `parseApiResponse` are missing.

- [ ] **Step 3: Implement the local endpoints**

Add:

- `GET /guardrails/repositories`
- `POST /guardrails/repositories`
- `GET /guardrails/repositories/:repositoryKey/policy`
- `PUT /guardrails/repositories/:repositoryKey/policy`
- `POST /guardrails/repositories/:repositoryKey/policy/simulate`
- `GET /guardrails/gates`
- `POST /guardrails/gates`
- `GET /guardrails/gates/:gateId`
- `GET /guardrails/gates/:gateId/events`
- `POST /guardrails/gates/:gateId/cancel`

Enrollment resolves the Git root and policy path server-side. Policy PUT validates then writes atomically. Simulation loads an existing GateArtifact, reads `.csb/guardrails-exceptions.json`, ignores expired entries for the decision, returns each expiry under `configurationErrors`, and never writes a file.

Use SSE event names `status`, `scan`, `decision`, `done`, `error`. End the stream on `done` or `error` and unsubscribe on abort.

- [ ] **Step 4: Implement robust response parsing**

Create:

```ts
export async function parseApiResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: (T & { error?: string }) | null = null;
  if (text) {
    try {
      body = JSON.parse(text) as T & { error?: string };
    } catch {
      if (response.ok) throw new Error("A API retornou uma resposta inválida.");
    }
  }
  if (!response.ok) throw new Error(body?.error ?? `API indisponível (HTTP ${response.status})`);
  if (!body) throw new Error("A API retornou uma resposta vazia.");
  return body;
}
```

Change `request<T>` in `apps/web/src/api.ts` to call `parseApiResponse<T>(res)`. Add typed API methods for repositories, gates, policy, simulation and cancellation.

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
pnpm --filter @csb/api test
pnpm --filter @csb/web test
pnpm typecheck
```

Expected: route and HTTP error tests pass; raw `Unexpected end of JSON input` is no longer possible in API requests.

- [ ] **Step 6: Commit API and client transport**

```bash
git add apps/api/src/app.ts apps/api/src/guardrails.test.ts apps/web/src/api.ts apps/web/src/lib/http.ts apps/web/src/lib/http.test.ts
git commit -m "feat: expose local guardrail API"
```

---

### Task 8: Portfolio Pipeline and Decision Graph UI

**Files:**
- Create: `apps/web/src/lib/guardrails.ts`
- Create: `apps/web/src/lib/guardrails.test.ts`
- Create: `apps/web/src/components/guardrails/GateOutcomeBadge.tsx`
- Create: `apps/web/src/components/guardrails/PortfolioPipeline.tsx`
- Create: `apps/web/src/components/guardrails/DecisionGraph.tsx`
- Create: `apps/web/src/components/guardrails/EvidenceTrace.tsx`
- Create: `apps/web/src/components/guardrails/DecisionEquation.tsx`
- Create: `apps/web/src/components/guardrails/index.ts`
- Create: `apps/web/src/pages/GuardrailsPage.tsx`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: `GateRun`, `GateArtifact`, `DecisionGraphNode` and Guardrails API methods.
- Produces: `/guardrails` and `/guardrails/:gateId` with lane/node deep links.

- [ ] **Step 1: Read required frontend skills and write pure interaction tests**

Before editing frontend files, read the complete `frontend-design`, `impeccable` and `ui-ux-pro-max` skill instructions.

Create tests:

```ts
test("selects the requested gate or falls back to the first blocked lane", () => {
  assert.equal(selectGate(gatesFixture(), "gate-pass").id, "gate-pass");
  assert.equal(selectGate(gatesFixture(), null).id, "gate-blocked");
});

test("selects a valid graph node and falls back to the graph default", () => {
  const graph = graphFixture();
  assert.equal(selectDecisionNode(graph, "rule").id, "rule");
  assert.equal(selectDecisionNode(graph, "missing").id, graph.selectedNodeId);
});

test("builds a reloadable guardrail URL", () => {
  assert.equal(guardrailHref("gate-1", "signal"), "/guardrails/gate-1?node=signal");
});
```

- [ ] **Step 2: Run web tests and verify missing helpers**

Run: `pnpm --filter @csb/web test`

Expected: FAIL because Guardrails helpers do not exist.

- [ ] **Step 3: Implement pure selection/view-model helpers**

Implement `selectGate`, `selectDecisionNode`, `guardrailHref`, `gateStageLabel`, `gateOutcomeTone` and `evidenceForNode`. `selectGate` priority is: requested ID, first blocked, first scanning, newest gate.

- [ ] **Step 4: Implement the approved hybrid screen**

Add `Guardrails` before `Operar` in the main navigation. Preserve semantic numbering and correct active-state matching for `/guardrails/*`.

`PortfolioPipeline`:

- desktop: one continuous grid with repository, changeset, scope, scan, decision and PR Check columns;
- mobile: one expandable lane per gate, no document-level horizontal overflow;
- lanes are `<button>` elements with `aria-current` on selection;
- status uses text plus icon, never color alone.

`DecisionGraph`:

- desktop: five connected stages in one horizontal rail;
- mobile: vertical rail;
- every node is a button with `aria-pressed`;
- missing evidence renders `Não determinado` rather than an invented label.

`GuardrailsPage`:

- reads `gateId` from route and `node` from query;
- loads gate list and selected artifact in parallel;
- subscribes to SSE while selected gate is active;
- updates only the selected gate on events;
- renders error, empty/bootstrap and no_changes states explicitly;
- links finding nodes to the existing Attack Path route when `sourceScanId` and finding ID exist.

Use only existing Shadcn/DaisyUI primitives and Tailwind utilities. Do not add styles to `styles.css`.

- [ ] **Step 5: Run web gates**

Run:

```bash
pnpm --filter @csb/web test
pnpm --filter @csb/web typecheck
pnpm --filter @csb/web build
```

Expected: helpers pass, TypeScript exits 0 and Vite builds the new routes.

- [ ] **Step 6: Commit Guardrails workspace UI**

```bash
git add apps/web/src/App.tsx apps/web/src/lib/guardrails.ts apps/web/src/lib/guardrails.test.ts apps/web/src/components/guardrails apps/web/src/pages/GuardrailsPage.tsx
git commit -m "feat: add guardrail pipeline and decision graph"
```

---

### Task 9: Policy Editor, simulation and final local validation

**Files:**
- Create: `apps/web/src/pages/GuardrailPolicyPage.tsx`
- Create: `apps/web/src/components/guardrails/PolicyRuleEditor.tsx`
- Create: `apps/web/src/components/guardrails/PolicyDiffPreview.tsx`
- Modify: `apps/web/src/components/guardrails/index.ts`
- Modify: `apps/web/src/lib/guardrails.test.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/api.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: policy GET/PUT/simulate endpoints and existing GateArtifact IDs.
- Produces: `/guardrails/repositories/:repositoryKey/policy`.

- [ ] **Step 1: Add policy serialization tests**

Add to `guardrails.test.ts`:

```ts
test("serializes the visual editor without changing rule order", () => {
  const policy = policyFixture();
  assert.deepEqual(policyFromEditor(editorStateFromPolicy(policy)).rules, policy.rules);
});

test("rejects an invalid cost before calling the API", () => {
  assert.deepEqual(validatePolicyEditor({ ...editorFixture(), maxCostUsd: 0 }), {
    field: "maxCostUsd",
    message: "O envelope deve ser maior que US$ 0.",
  });
});
```

- [ ] **Step 2: Run tests and verify missing editor helpers**

Run: `pnpm --filter @csb/web test`

Expected: FAIL because editor conversion and validation helpers do not exist.

- [ ] **Step 3: Implement editor and diff confirmation**

The page must include:

- protected branches;
- scope mode, path ceiling and fallback;
- model, effort, mode and USD envelope;
- ordered rules with severity, lifecycle and decision;
- simulation selector using existing GateRuns;
- configuration-error rows for expired exceptions, including owner and expiry date;
- exact JSON before/after diff;
- save button disabled until validation passes;
- confirmation dialog that states the exact `.csb/guardrails.json` path.

Saving calls PUT only after confirmation. It never commits or pushes. On success, reload the policy from the API and show `Arquivo atualizado no workspace`.

- [ ] **Step 4: Run complete deterministic gates**

Run under Node 24.17.0:

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 5: Run live local validation**

Start with `npm run dev`. Verify:

```bash
curl -fsS http://127.0.0.1:8787/health
curl -fsS http://127.0.0.1:5173/api/guardrails/repositories
```

Expected: both return JSON and HTTP 200.

In the browser validate 390px, 1024px and 1600px:

- enroll a temporary Git repository;
- run no_changes without starting a scan;
- run a changed-path preflight with a fake scanner fixture or bounded test repository;
- select lanes and every Decision Graph node;
- reload deep links;
- simulate policy without a file write;
- save policy after confirmation;
- cancel an active gate;
- confirm no page overlap or document-level overflow;
- confirm console has no product errors or warnings.

- [ ] **Step 6: Update local documentation**

Document enrollment, `.csb/guardrails.json`, local preflight, outcomes and the fact that GitHub publication belongs to the next plan. Do not document GitHub as delivered yet.

- [ ] **Step 7: Commit the completed local gate**

```bash
git add apps/web/src/App.tsx apps/web/src/api.ts apps/web/src/pages/GuardrailPolicyPage.tsx apps/web/src/components/guardrails README.md
git commit -m "feat: complete local security change gate"
```

---

## Local Release Gate

The local plan is complete only when:

- `pnpm test`, `pnpm typecheck`, `pnpm build` and `git diff --check` pass;
- `npm run dev` starts API and web with Node 24.17.0;
- no_changes consumes no scan or cost;
- bootstrap never renders pass;
- engine failure never renders pass;
- changed paths and cost envelope reach the scanner;
- Decision Graph never invents missing evidence;
- policy simulation does not write;
- policy save writes only after confirmation;
- visual QA passes at 390px, 1024px and 1600px;
- changes are committed in the task commits above without `.superpowers/`.
