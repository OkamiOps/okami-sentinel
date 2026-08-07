# Attack Path Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transformar o fluxo textual dos findings em um preview rastreável no Inspector e em um Attack Explorer dedicado, sem inventar etapas ausentes.

**Architecture:** A API normaliza `attackPath`, `codeEvidence` e `validation` em um contrato tipado e preserva o payload bruto. O frontend usa o mesmo `AttackPathModel` em componentes compartilhados para o preview e para a rota dedicada, mantendo contexto de lifecycle e baseline por deep link.

**Tech Stack:** TypeScript 5.8, Node test runner via `tsx`, Hono, React 19, React Router 7, Tailwind 4, Shadcn, DaisyUI e Hugeicons. Nenhuma biblioteca nova de grafos.

## Global Constraints

- Usar o design system Test Bench documentado em `apps/web/DESIGN.md`.
- Antes de qualquer tarefa visual, ler e aplicar a skill `frontend-design`.
- Antes da validação em navegador, ler e aplicar a skill `playwright`.
- Não criar primitives manuais para Button, Sheet, input ou controle já fornecido por Shadcn/DaisyUI.
- Não adicionar biblioteca de grafos; a trilha é ordenada com layout CSS e conectores simples.
- Nunca inferir `unreachable`; ausência de cadeia significa `partial`, `unstructured` ou `null`.
- Não fabricar nós ou caminhos alternativos que o finding não forneceu.
- O documento nunca pode criar scroll horizontal; overflow largo fica restrito ao bloco de código.
- Validar 1600×1000, 1024×768 e 390×844, foco por teclado, contraste e `prefers-reduced-motion`.
- O worktree atual contém mudanças aceitas ainda não commitadas em arquivos que este plano também toca. Antes da execução, inventariar `git status --short`; nunca incluir alterações alheias em um commit sem revisar `git diff --cached`.
- Se não houver um baseline limpo para commits atômicos, executar e validar as tarefas no worktree atual, mas adiar os commits de implementação até que o usuário autorize o checkpoint das mudanças existentes.

---

## File Map

### Create

- `apps/api/src/attack-path.ts` — normalização pura do schema bruto.
- `apps/api/src/attack-path.test.ts` — contrato do normalizador.
- `apps/api/src/fixtures/attack-path/findings.json` — fixture estática de ingestão.
- `apps/api/src/ingest-attack-path.test.ts` — integração entre ingestão e modelo normalizado.
- `apps/web/src/lib/attack-path.ts` — seleção e construção de deep links.
- `apps/web/src/lib/attack-path.test.ts` — testes dos helpers de navegação.
- `apps/web/src/components/attack-path/AttackPathNode.tsx` — controle acessível de uma etapa.
- `apps/web/src/components/attack-path/AttackPathStage.tsx` — trilha responsiva compartilhada.
- `apps/web/src/components/attack-path/AttackPathEvidence.tsx` — evidência do nó selecionado.
- `apps/web/src/components/attack-path/AttackPathPreview.tsx` — composição compacta do Inspector.
- `apps/web/src/components/attack-path/index.ts` — exports públicos da feature.
- `apps/web/src/components/LifecycleBadge.tsx` — badge compartilhado entre detalhe e Explorer.
- `apps/web/src/components/InspectorPrimitives.tsx` — seções, listas e readouts reutilizados pelo Inspector e pelo preview.
- `apps/web/src/pages/AttackPathPage.tsx` — rota dedicada e orquestração do Explorer.

### Modify

- `packages/shared/src/index.ts` — tipos `AttackPath*` e `FindingDetail.attackPathModel`.
- `apps/api/package.json` — incluir todos os testes `src/*.test.ts`.
- `apps/api/src/ingest.ts` — anexar o modelo normalizado ao detalhe.
- `apps/web/package.json` — script de teste e `tsx` como dev dependency.
- `pnpm-lock.yaml` — resolução do script de teste web.
- `apps/web/src/App.tsx` — rota do Attack Explorer.
- `apps/web/src/pages/ScanDetailPage.tsx` — substituir `AttackFlow`, usar preview e extrair badge.

---

### Task 1: Shared contract and pure normalizer

**Files:**
- Modify: `packages/shared/src/index.ts:97`
- Modify: `apps/api/package.json:8`
- Create: `apps/api/src/attack-path.test.ts`
- Create: `apps/api/src/attack-path.ts`

**Interfaces:**
- Consumes: raw `FindingDetail.attackPath`, `FindingDetail.codeEvidence`, `FindingDetail.validation`.
- Produces: `normalizeAttackPath(input: AttackPathInput): AttackPathModel | null` and the exact shared types used by every later task.

- [ ] **Step 1: Add the shared contract**

Insert before `FindingDetail` and add `attackPathModel` to `FindingDetail`:

```ts
export type AttackPathEvidenceState = "proven" | "inferred" | "missing";

export type AttackPathNodeKind =
  | "attacker"
  | "source"
  | "entrypoint"
  | "implementation"
  | "control"
  | "sink"
  | "evidence"
  | "outcome";

export interface AttackPathLocation {
  path: string;
  startLine: number | null;
  endLine: number | null;
}

export interface AttackPathNode {
  id: string;
  kind: AttackPathNodeKind;
  label: string;
  summary: string | null;
  evidenceState: AttackPathEvidenceState;
  evidenceRef: string | null;
  location: AttackPathLocation | null;
  code: string | null;
  language: string | null;
  explanation: string | null;
}

export interface AttackPathLane {
  id: string;
  label: string;
  nodes: AttackPathNode[];
}

export interface AttackPathModel {
  status: "validated" | "partial" | "unstructured";
  summary: string | null;
  preconditions: string | null;
  limitations: string[];
  impact: { level: string | null; rationale: string | null };
  likelihood: { level: string | null; rationale: string | null };
  lanes: AttackPathLane[];
  warnings: string[];
}

export interface FindingDetail extends FindingSummary {
  attackPath: unknown;
  attackPathModel: AttackPathModel | null;
  codeEvidence: unknown[];
  remediation: unknown;
  locations: unknown;
  taxonomy: unknown;
  rootCause: unknown;
  validation: unknown;
  preventiveControls: unknown;
  remediationTests: unknown;
  severityRationale: string | null;
  confidenceRationale: string | null;
}
```

- [ ] **Step 2: Make the API test script include the new suite**

Change the script to:

```json
"test": "tsx --test src/*.test.ts"
```

- [ ] **Step 3: Write failing normalizer tests**

Create `apps/api/src/attack-path.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { FindingDetail } from "@csb/shared";
import { normalizeAttackPath } from "./attack-path.js";

function finding(overrides: Partial<FindingDetail> = {}): FindingDetail {
  return {
    findingId: "finding-1",
    occurrenceId: "occ-1",
    title: "Stored script reaches report writer",
    severity: "high",
    confidence: "high",
    ruleId: "xss.report",
    summary: "Stored markup reaches document.write.",
    primaryPath: "src/export.ts",
    fingerprints: ["sha256:one"],
    category: "Stored cross-site scripting",
    cwe: ["CWE-79"],
    attackPath: {
      evidenceRefs: ["source-1", "root_control-2", "sink-3"],
      dataflow: { summary: "Source reaches sink", outcome: "Script execution" },
      reachability: { attacker: "tenant member", preconditions: "Victim opens report" },
      impact: { level: "high", why: "Same-origin execution" },
      likelihood: { level: "high", why: "Reachable write" },
      limitations: ["Victim interaction is required"],
    },
    attackPathModel: null,
    codeEvidence: [
      { id: "source-1", role: "source", label: "Writable field", path: "src/input.ts", startLine: 10, endLine: 12, code: "save(input)", language: "typescript", explanation: "Attacker-controlled source" },
      { id: "root_control-2", role: "root_control", label: "Missing encoding", path: "src/export.ts", startLine: 20, endLine: 22, code: "return `<td>${value}</td>`", language: "typescript", explanation: "Closest control" },
      { id: "sink-3", role: "sink", label: "Document writer", path: "src/export.ts", startLine: 40, endLine: 40, code: "document.write(html)", language: "typescript", explanation: "Protected sink" },
    ],
    remediation: null,
    locations: null,
    taxonomy: null,
    rootCause: null,
    validation: { method: "source/sink trace", summary: "Validated statically" },
    preventiveControls: null,
    remediationTests: null,
    severityRationale: null,
    confidenceRationale: null,
    ...overrides,
  };
}

test("normalizes resolved evidence in declared order", () => {
  const model = normalizeAttackPath(finding());
  assert.equal(model?.status, "validated");
  assert.deepEqual(model?.lanes[0]?.nodes.map((node) => node.id), [
    "primary:attacker", "source-1", "root_control-2", "sink-3", "primary:outcome",
  ]);
  assert.equal(model?.lanes[0]?.nodes[1]?.evidenceState, "proven");
});

test("renders missing references as explicit gaps", () => {
  const raw = finding();
  const attack = raw.attackPath as { evidenceRefs: string[] };
  attack.evidenceRefs = ["source-1", "missing-control", "sink-3"];
  const model = normalizeAttackPath(raw);
  assert.equal(model?.status, "partial");
  assert.equal(model?.lanes[0]?.nodes[2]?.evidenceState, "missing");
});

test("uses code evidence when attackPath is absent", () => {
  const model = normalizeAttackPath(finding({ attackPath: null, validation: null }));
  assert.equal(model?.status, "partial");
  assert.equal(model?.lanes[0]?.id, "primary");
});

test("returns null when neither path nor evidence exists", () => {
  assert.equal(normalizeAttackPath(finding({ attackPath: null, codeEvidence: [], validation: null })), null);
});

test("maps unknown roles to evidence", () => {
  const raw = finding({ attackPath: null, validation: null, codeEvidence: [{ id: "odd-1", role: "custom_role", path: "src/a.ts" }] });
  assert.equal(normalizeAttackPath(raw)?.lanes[0]?.nodes[0]?.kind, "evidence");
});

test("produces stable ids across repeated normalization", () => {
  const first = normalizeAttackPath(finding());
  const second = normalizeAttackPath(finding());
  assert.deepEqual(first?.lanes[0]?.nodes.map((node) => node.id), second?.lanes[0]?.nodes.map((node) => node.id));
});

test("normalizes explicit alternative paths without synthesizing lanes", () => {
  const raw = finding();
  raw.attackPath = {
    ...(raw.attackPath as Record<string, unknown>),
    paths: [
      { id: "write-path", label: "Write path", evidenceRefs: ["source-1", "sink-3"] },
      { id: "control-path", label: "Control path", evidenceRefs: ["root_control-2", "sink-3"] },
    ],
  };
  assert.deepEqual(normalizeAttackPath(raw)?.lanes.map((lane) => lane.id), ["write-path", "control-path"]);
});
```

- [ ] **Step 4: Run the suite and verify the failure**

Run:

```bash
pnpm --filter @csb/api test
```

Expected: FAIL because `./attack-path.js` does not exist.

- [ ] **Step 5: Implement the pure normalizer**

Create `apps/api/src/attack-path.ts` with these exact exported boundaries:

```ts
import type { AttackPathModel, AttackPathNode, AttackPathNodeKind, FindingDetail } from "@csb/shared";

export type AttackPathInput = Pick<FindingDetail, "attackPath" | "codeEvidence" | "validation">;
type DataRecord = Record<string, unknown>;

const roleKinds: Record<string, AttackPathNodeKind> = {
  attacker: "attacker",
  source: "source",
  entrypoint: "entrypoint",
  concrete_implementation: "implementation",
  implementation: "implementation",
  root_control: "control",
  control: "control",
  sink: "sink",
  evidence: "evidence",
  outcome: "outcome",
};

const record = (value: unknown): DataRecord | null => value != null && typeof value === "object" && !Array.isArray(value) ? value as DataRecord : null;
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];

function evidenceNode(ref: string, item: DataRecord | undefined, warnings: string[]): AttackPathNode {
  if (!item) {
    warnings.push(`Evidence reference not found: ${ref}`);
    return { id: ref, kind: "evidence", label: ref, summary: null, evidenceState: "missing", evidenceRef: ref, location: null, code: null, language: null, explanation: null };
  }
  const role = text(item.role) ?? "evidence";
  const path = text(item.path);
  return {
    id: ref,
    kind: roleKinds[role] ?? "evidence",
    label: text(item.label) ?? role.replaceAll("_", " "),
    summary: text(item.explanation),
    evidenceState: "proven",
    evidenceRef: ref,
    location: path ? { path, startLine: number(item.startLine), endLine: number(item.endLine) } : null,
    code: text(item.code),
    language: text(item.language),
    explanation: text(item.explanation),
  };
}

function inferredNode(id: string, kind: AttackPathNodeKind, label: string, summary: string): AttackPathNode {
  return { id, kind, label, summary, evidenceState: "inferred", evidenceRef: null, location: null, code: null, language: null, explanation: null };
}

export function normalizeAttackPath(input: AttackPathInput): AttackPathModel | null {
  const attack = record(input.attackPath);
  const evidenceRows = Array.isArray(input.codeEvidence) ? input.codeEvidence.map(record).filter((item): item is DataRecord => Boolean(item)) : [];
  if (!attack && evidenceRows.length === 0) return null;

  const evidence = new Map(evidenceRows.map((item, index) => [text(item.id) ?? `evidence-${index + 1}`, item]));
  const dataflow = record(attack?.dataflow);
  const reachability = record(attack?.reachability);
  const validation = record(input.validation);
  const warnings: string[] = [];
  const attacker = text(reachability?.attacker);
  const outcome = text(dataflow?.outcome) ?? text(reachability?.outcome);
  const explicitPaths = Array.isArray(attack?.paths) ? attack.paths.map(record).filter((item): item is DataRecord => Boolean(item)) : [];
  const primaryRefs = strings(attack?.evidenceRefs).length > 0 ? strings(attack?.evidenceRefs) : strings(dataflow?.evidenceRefs);
  const laneSpecs = explicitPaths.length > 0
    ? explicitPaths.map((item, index) => ({ id: text(item.id) ?? `path-${index + 1}`, label: text(item.label) ?? `Path ${index + 1}`, refs: strings(item.evidenceRefs) }))
    : [{ id: "primary", label: "Primary path", refs: primaryRefs.length > 0 ? primaryRefs : [...evidence.keys()] }];
  const lanes = laneSpecs.map((lane) => {
    const nodes = lane.refs.map((ref) => evidenceNode(ref, evidence.get(ref), warnings));
    if (attacker) nodes.unshift(inferredNode(`${lane.id}:attacker`, "attacker", "Attacker", attacker));
    if (outcome) nodes.push(inferredNode(`${lane.id}:outcome`, "outcome", "Outcome", outcome));
    return { id: lane.id, label: lane.label, nodes };
  });

  const allNodes = lanes.flatMap((lane) => lane.nodes);
  const hasEntry = allNodes.some((node) => node.evidenceState === "proven" && (node.kind === "source" || node.kind === "entrypoint"));
  const hasSink = allNodes.some((node) => node.evidenceState === "proven" && node.kind === "sink");
  const hasValidation = Boolean(text(validation?.method) ?? text(validation?.summary));
  const status: AttackPathModel["status"] = hasEntry && hasSink && hasValidation && warnings.length === 0 ? "validated" : allNodes.length > 0 ? "partial" : "unstructured";
  const impact = record(attack?.impact);
  const likelihood = record(attack?.likelihood);

  return {
    status,
    summary: text(attack?.summary) ?? text(dataflow?.summary),
    preconditions: text(reachability?.preconditions),
    limitations: strings(attack?.limitations),
    impact: { level: text(impact?.level), rationale: text(impact?.why) },
    likelihood: { level: text(likelihood?.level), rationale: text(likelihood?.why) },
    lanes,
    warnings,
  };
}
```

- [ ] **Step 6: Run tests and types**

Run:

```bash
pnpm --filter @csb/api test
pnpm typecheck
```

Expected: all normalizer and lifecycle tests PASS; all packages typecheck.

- [ ] **Step 7: Commit the task if the staged diff is isolated**

```bash
git add packages/shared/src/index.ts apps/api/package.json apps/api/src/attack-path.ts apps/api/src/attack-path.test.ts
git diff --cached --check
git commit -m "feat: normalize attack path evidence"
```

Expected: commit contains only the files listed above. If an overlapping file contains earlier accepted work, stop before `git commit` and leave the verified changes unstaged for the baseline checkpoint decision.

---

### Task 2: Enrich finding ingestion and API response

**Files:**
- Create: `apps/api/src/fixtures/attack-path/findings.json`
- Create: `apps/api/src/ingest-attack-path.test.ts`
- Modify: `apps/api/src/ingest.ts:233-348`

**Interfaces:**
- Consumes: `normalizeAttackPath(detail)` from Task 1.
- Produces: every `FindingDetail` returned by `readFindingsFile()` has `attackPathModel`; the existing detail endpoint needs no new route.

- [ ] **Step 1: Add a static ingestion fixture**

Create `apps/api/src/fixtures/attack-path/findings.json` with one finding containing `attackPath.evidenceRefs`, source/sink `codeEvidence`, and `validation.method`. Use IDs `source-1` and `sink-2`; the fixture must not reference real user paths.

```json
{
  "findings": [{
    "findingId": "fixture-finding",
    "title": "Fixture path",
    "severity": { "level": "high" },
    "attackPath": { "evidenceRefs": ["source-1", "sink-2"], "dataflow": { "outcome": "Fixture impact" } },
    "codeEvidence": [
      { "id": "source-1", "role": "source", "path": "src/input.ts", "startLine": 1, "code": "read(input)" },
      { "id": "sink-2", "role": "sink", "path": "src/output.ts", "startLine": 2, "code": "write(input)" }
    ],
    "validation": { "method": "fixture trace" }
  }]
}
```

- [ ] **Step 2: Write the failing ingestion test**

Create `apps/api/src/ingest-attack-path.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFindingsFile } from "./ingest.js";

test("readFindingsFile attaches the normalized attack path", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const findings = readFindingsFile(path.join(here, "fixtures/attack-path"));
  assert.equal(findings[0]?.findingId, "fixture-finding");
  assert.equal(findings[0]?.attackPathModel?.status, "validated");
  assert.deepEqual(findings[0]?.attackPathModel?.lanes[0]?.nodes.map((node) => node.id), ["source-1", "sink-2", "primary:outcome"]);
});
```

- [ ] **Step 3: Run the test and verify the failure**

Run `pnpm --filter @csb/api test`.

Expected: FAIL because `attackPathModel` is still absent or `null`.

- [ ] **Step 4: Attach the normalized model during ingestion**

Import `normalizeAttackPath` in `apps/api/src/ingest.ts`. Replace the direct object return in the `map` callback with:

```ts
const detail: FindingDetail = {
  findingId: String(f.findingId ?? f.occurrenceId ?? cryptoRandom()),
  occurrenceId: typeof f.occurrenceId === "string" ? f.occurrenceId : null,
  title: String(f.title ?? "Untitled finding"),
  severity: normalizeSeverity(f.severity),
  confidence,
  ruleId: typeof f.ruleId === "string" ? f.ruleId : null,
  summary: typeof f.summary === "string" ? f.summary : null,
  primaryPath,
  fingerprints,
  category,
  cwe,
  attackPath: f.attackPath ?? null,
  attackPathModel: null,
  codeEvidence: Array.isArray(f.codeEvidence) ? f.codeEvidence : [],
  remediation: f.remediation ?? null,
  locations: f.locations ?? null,
  taxonomy: f.taxonomy ?? null,
  rootCause: f.rootCause ?? null,
  validation: f.validation ?? null,
  preventiveControls: f.preventiveControls ?? null,
  remediationTests: f.remediationTests ?? null,
  severityRationale: severityObj && typeof severityObj.rationale === "string" ? severityObj.rationale : null,
  confidenceRationale,
};
return { ...detail, attackPathModel: normalizeAttackPath(detail) };
```

- [ ] **Step 5: Verify unit, integration and live API shape**

Run:

```bash
pnpm --filter @csb/api test
pnpm typecheck
curl -s 'http://127.0.0.1:8787/scans/0bd1c456-31e4-4f16-a6bd-762804825f7f/findings/csf_7c14ea4a6cce2dc240e6e832'
```

Expected: tests and types PASS; live JSON contains `finding.attackPathModel.status`, `lanes[0].id === "primary"`, and ordered nodes.

- [ ] **Step 6: Commit the integration if isolated**

```bash
git add apps/api/src/ingest.ts apps/api/src/ingest-attack-path.test.ts apps/api/src/fixtures/attack-path/findings.json
git diff --cached --check
git commit -m "feat: enrich finding details with attack paths"
```

---

### Task 3: Frontend navigation helpers

**Files:**
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/web/src/lib/attack-path.test.ts`
- Create: `apps/web/src/lib/attack-path.ts`

**Interfaces:**
- Consumes: `AttackPathModel`, `AttackPathLane`, `AttackPathNode`.
- Produces: `getAttackPathSelection()`, `getAttackPathStageItems()`, `attackPathHref()` and stable preview selection for Tasks 4–6.

- [ ] **Step 1: Add the existing workspace test runner to web**

Run:

```bash
pnpm --filter @csb/web add -D tsx@^4.20.3
```

Add this script:

```json
"test": "tsx --test src/lib/*.test.ts"
```

- [ ] **Step 2: Write failing helper tests**

Create `apps/web/src/lib/attack-path.test.ts` covering:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { AttackPathModel } from "@csb/shared";
import { attackPathHref, getAttackPathSelection, getAttackPathStageItems } from "./attack-path.js";

const model: AttackPathModel = {
  status: "validated", summary: null, preconditions: null, limitations: [],
  impact: { level: null, rationale: null }, likelihood: { level: null, rationale: null }, warnings: [],
  lanes: [{ id: "primary", label: "Primary path", nodes: [
    { id: "inferred", kind: "attacker", label: "Attacker", summary: null, evidenceState: "inferred", evidenceRef: null, location: null, code: null, language: null, explanation: null },
    { id: "source-1", kind: "source", label: "Source", summary: null, evidenceState: "proven", evidenceRef: "source-1", location: null, code: null, language: null, explanation: null },
  ] }],
};

test("selects the first proven node by default", () => {
  assert.equal(getAttackPathSelection(model, null, null).node.id, "source-1");
});

test("falls back from invalid lane and node", () => {
  const selected = getAttackPathSelection(model, "missing", "missing");
  assert.equal(selected.lane.id, "primary");
  assert.equal(selected.node.id, "source-1");
});

test("builds baseline-aware deep links", () => {
  assert.equal(
    attackPathHref({ scanId: "current", findingId: "finding", evidenceScanId: "baseline", laneId: "primary", nodeId: "source-1" }),
    "/scans/current/findings/finding/path?evidenceScan=baseline&lane=primary&node=source-1",
  );
});

test("compacts long previews without changing the full lane", () => {
  const base = model.lanes[0]!.nodes[1]!;
  const lane = { ...model.lanes[0]!, nodes: Array.from({ length: 7 }, (_, index) => ({ ...base, id: `node-${index}` })) };
  const items = getAttackPathStageItems(lane, true);
  assert.equal(items.length, 5);
  assert.deepEqual(items.map((item) => item.type), ["node", "node", "collapsed", "node", "node"]);
  assert.equal(items[2]?.type === "collapsed" ? items[2].count : 0, 3);
  assert.equal(lane.nodes.length, 7);
});
```

- [ ] **Step 3: Run the test and verify the failure**

Run `pnpm --filter @csb/web test`.

Expected: FAIL because `src/lib/attack-path.ts` does not exist.

- [ ] **Step 4: Implement exact navigation helpers**

Create `apps/web/src/lib/attack-path.ts`:

```ts
import type { AttackPathLane, AttackPathModel, AttackPathNode } from "@csb/shared";

export type AttackPathStageItem =
  | { type: "node"; node: AttackPathNode }
  | { type: "collapsed"; id: string; count: number };

export function getAttackPathSelection(model: AttackPathModel, laneId: string | null, nodeId: string | null): { lane: AttackPathLane; node: AttackPathNode } {
  const lane = model.lanes.find((item) => item.id === laneId) ?? model.lanes[0];
  if (!lane || lane.nodes.length === 0) throw new Error("Attack path sem etapas selecionáveis");
  const node = lane.nodes.find((item) => item.id === nodeId) ?? lane.nodes.find((item) => item.evidenceState === "proven") ?? lane.nodes[0];
  return { lane, node: node! };
}

export function getAttackPathStageItems(lane: AttackPathLane, compact: boolean): AttackPathStageItem[] {
  const nodes = lane.nodes.map((node) => ({ type: "node" as const, node }));
  if (!compact || nodes.length <= 5) return nodes;
  return [nodes[0]!, nodes[1]!, { type: "collapsed", id: `${lane.id}:collapsed`, count: nodes.length - 4 }, nodes[nodes.length - 2]!, nodes[nodes.length - 1]!];
}

export function attackPathHref(input: { scanId: string; findingId: string; evidenceScanId: string; laneId: string; nodeId: string }): string {
  const params = new URLSearchParams();
  if (input.evidenceScanId !== input.scanId) params.set("evidenceScan", input.evidenceScanId);
  params.set("lane", input.laneId);
  params.set("node", input.nodeId);
  return `/scans/${encodeURIComponent(input.scanId)}/findings/${encodeURIComponent(input.findingId)}/path?${params.toString()}`;
}
```

- [ ] **Step 5: Run helper tests and typecheck**

Run:

```bash
pnpm --filter @csb/web test
pnpm --filter @csb/web typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit the helpers if isolated**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src/lib/attack-path.ts apps/web/src/lib/attack-path.test.ts
git diff --cached --check
git commit -m "test: define attack path navigation"
```

---

### Task 4: Reusable attack path components

**Files:**
- Create: `apps/web/src/components/attack-path/AttackPathNode.tsx`
- Create: `apps/web/src/components/attack-path/AttackPathStage.tsx`
- Create: `apps/web/src/components/attack-path/AttackPathEvidence.tsx`
- Create: `apps/web/src/components/attack-path/AttackPathPreview.tsx`
- Create: `apps/web/src/components/attack-path/index.ts`
- Create: `apps/web/src/components/LifecycleBadge.tsx`
- Create: `apps/web/src/components/InspectorPrimitives.tsx`

**Interfaces:**
- Consumes: `AttackPathModel`, `AttackPathLane`, `AttackPathNode`, `FindingLifecycle`, and `attackPathHref()`.
- Produces: reusable preview and stage components; no component reads raw `unknown` finding data.

- [ ] **Step 1: Read the required frontend skill and current design contract**

Read completely:

```bash
cat /Users/marcos/.agents/skills/frontend-design/SKILL.md
cat apps/web/DESIGN.md
```

Expected: implementation follows Test Bench, Shadcn/DaisyUI primitives and responsive validation requirements.

- [ ] **Step 2: Create the shared lifecycle badge**

Move the existing lifecycle label, tone and border maps from `ScanDetailPage.tsx` into `apps/web/src/components/LifecycleBadge.tsx`. Export:

```ts
export function LifecycleBadge({ state }: { state: FindingLifecycle }): JSX.Element;
```

Preserve the exact current labels and visual tokens.

- [ ] **Step 3: Create `AttackPathNode` as a native button**

The component contract is:

```tsx
export function AttackPathNodeButton({ node, index, total, selected, onSelect }: {
  node: AttackPathNode;
  index: number;
  total: number;
  selected: boolean;
  onSelect: (node: AttackPathNode) => void;
}) {
  const stateLabel = { proven: "comprovado", inferred: "inferido", missing: "evidência ausente" }[node.evidenceState];
  return <button
    type="button"
    aria-pressed={selected}
    aria-label={`${node.label}, ${stateLabel}, etapa ${index + 1} de ${total}`}
    onClick={() => onSelect(node)}
    className={cx("min-w-0 border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", selected ? "border-primary bg-accent" : "border-border hover:bg-accent/60")}
  >
    <span className="bench-label">{String(index + 1).padStart(2, "0")} / {node.kind}</span>
    <strong className="mt-2 block truncate text-xs">{node.label}</strong>
    <span className="mt-2 block font-mono text-[8px] uppercase text-muted-foreground">{stateLabel}</span>
  </button>;
}
```

- [ ] **Step 4: Create the responsive stage**

`AttackPathStage` renders `getAttackPathStageItems(lane, compact)` in declared order. Use a horizontal grid from `lg` upward and a vertical stack below it. Connectors are neutral one-pixel elements placed between buttons; they are `aria-hidden`. Export:

```tsx
export function AttackPathStage({ lane, selectedNodeId, onSelectNode, compact = false }: {
  lane: AttackPathLane;
  selectedNodeId: string;
  onSelectNode: (node: AttackPathNode) => void;
  compact?: boolean;
}) {
  const items = getAttackPathStageItems(lane, compact);
  return <div className="max-w-full overflow-x-auto"><div className="grid gap-2 lg:min-w-max lg:grid-flow-col lg:auto-cols-[minmax(10rem,1fr)]">
    {items.map((item, index) => item.type === "collapsed"
      ? <div key={item.id} aria-label={`${item.count} etapas adicionais disponíveis no Explorer`} className="flex min-h-20 items-center justify-center border border-dashed px-3 text-center font-mono text-[9px] text-muted-foreground">+{item.count} etapas no Explorer</div>
      : <div key={item.node.id} className="relative min-w-0">
          <AttackPathNodeButton node={item.node} index={lane.nodes.indexOf(item.node)} total={lane.nodes.length} selected={item.node.id === selectedNodeId} onSelect={onSelectNode} />
          {index < items.length - 1 && <span aria-hidden className="absolute -bottom-2 left-5 h-2 w-px bg-border lg:-right-2 lg:bottom-auto lg:left-auto lg:top-1/2 lg:h-px lg:w-2" />}
        </div>)}
  </div></div>;
}
```

When an item has `type: "collapsed"`, render a non-interactive `<div aria-label="N etapas adicionais disponíveis no Explorer">+N etapas no Explorer</div>`. The full stage calls the helper with `compact === false` and therefore preserves every node.

- [ ] **Step 5: Create evidence and preview compositions**

`AttackPathEvidence` must always show state and location before optional code:

```tsx
export function AttackPathEvidence({ node, compact = false }: { node: AttackPathNode; compact?: boolean }) {
  const stateLabel = { proven: "comprovado", inferred: "inferido", missing: "evidência ausente" }[node.evidenceState];
  const location = node.location ? `${node.location.path}${node.location.startLine ? `:${node.location.startLine}${node.location.endLine && node.location.endLine !== node.location.startLine ? `-${node.location.endLine}` : ""}` : ""}` : null;
  const codeLines = node.code?.split("\n") ?? [];
  return <section aria-live="polite">
    <div className="border-b p-3"><div className="bench-label">{node.kind} / {stateLabel}</div><h2 className="mt-2 text-sm font-semibold">{node.label}</h2>{location && <div className="mt-2 break-all font-mono text-[9px] text-primary">{location}</div>}</div>
    <div className="border-b p-3 text-xs leading-6 text-muted-foreground">{node.explanation ?? node.summary ?? (node.evidenceState === "missing" ? "Evidência não anexada." : "Etapa inferida do resumo do scan.")}</div>
    {!compact && codeLines.length > 0 && <pre className="max-w-full overflow-x-auto bg-background py-3 font-mono text-[10px] leading-5"><code className="block min-w-max">{codeLines.map((line, index) => <span key={index} className="grid grid-cols-[3rem_minmax(0,1fr)]"><span className="border-r pr-2 text-right text-muted-foreground">{(node.location?.startLine ?? 1) + index}</span><span className="px-3">{line || " "}</span></span>)}</code></pre>}
  </section>;
}
```

Render:

- label and evidence state;
- `path:startLine-endLine` when present;
- explanation/summary;
- code with line numbers and local horizontal overflow;
- `Evidência não anexada` when `missing`;
- `Etapa inferida do resumo do scan` when `inferred`.

`AttackPathPreview` owns local selection and exports:

```tsx
export function AttackPathPreview({ model, explorerHref }: {
  model: AttackPathModel | null;
  explorerHref: (laneId: string, nodeId: string) => string;
}) {
  if (!model || model.lanes.length === 0 || model.lanes[0]!.nodes.length === 0) return <EmptyState title="Fluxo indisponível" description="Este finding não trouxe uma cadeia de ataque estruturada." />;
  return <AttackPathPreviewReady model={model} explorerHref={explorerHref} />;
}

function AttackPathPreviewReady({ model, explorerHref }: {
  model: AttackPathModel;
  explorerHref: (laneId: string, nodeId: string) => string;
}) {
  const lane = model.lanes[0]!;
  const defaultNode = getAttackPathSelection(model, lane.id, null).node;
  const [selectedId, setSelectedId] = useState(defaultNode.id);
  const selected = lane.nodes.find((node) => node.id === selectedId) ?? defaultNode;
  return <div>
    <div className="border-b p-4"><div className="flex items-center justify-between gap-3"><div className="bench-label">SOURCE → SINK TRACE / {model.status}</div><Button asChild variant="outline" size="sm"><Link to={explorerHref(lane.id, selected.id)}>Expandir investigação</Link></Button></div><div className="mt-4"><AttackPathStage lane={lane} selectedNodeId={selected.id} onSelectNode={(node) => setSelectedId(node.id)} compact /></div></div>
    <AttackPathEvidence node={selected} compact />
    <div className="grid border-b sm:grid-cols-2"><SignalCell label="Impacto" level={model.impact.level} detail={model.impact.rationale} /><SignalCell label="Probabilidade" level={model.likelihood.level} detail={model.likelihood.rationale} /></div>
    {model.limitations.length > 0 && <InspectorSection label="LIMITAÇÕES / CONTROLES PRÓXIMOS"><BulletList items={model.limitations} /></InspectorSection>}
  </div>;
}
```

Move the existing `SignalCell`, `InspectorSection` and `BulletList` implementations from `ScanDetailPage.tsx` into `apps/web/src/components/InspectorPrimitives.tsx` and export these exact contracts:

```ts
export function SignalCell(props: { label: string; level: string | null; detail: string | null }): ReactElement;
export function InspectorSection(props: { label: string; children: ReactNode }): ReactElement;
export function BulletList(props: { items: string[] }): ReactElement;
```

Import those exports in both `ScanDetailPage.tsx` and `AttackPathPreview.tsx`; do not duplicate them. The resulting preview renders the stage, selected evidence, impact/likelihood readouts, limitations, and a Shadcn `Button asChild` labeled `Expandir investigação`.

- [ ] **Step 6: Export the public surface and run types**

Create `index.ts` exporting only `AttackPathPreview`, `AttackPathStage` and `AttackPathEvidence`. Run:

```bash
pnpm --filter @csb/web test
pnpm --filter @csb/web typecheck
```

Expected: PASS; no raw `unknown` parsing exists under `components/attack-path`.

- [ ] **Step 7: Commit reusable components if isolated**

```bash
git add apps/web/src/components/attack-path apps/web/src/components/LifecycleBadge.tsx apps/web/src/components/InspectorPrimitives.tsx apps/web/src/pages/ScanDetailPage.tsx
git diff --cached --check
git commit -m "feat: add attack path visualization components"
```

---

### Task 5: Replace the Inspector flow with the preview

**Files:**
- Modify: `apps/web/src/pages/ScanDetailPage.tsx:62-194`

**Interfaces:**
- Consumes: `finding.attackPathModel`, `AttackPathPreview`, `attackPathHref`, shared `LifecycleBadge`.
- Produces: the Inspector tab `Fluxo` and a deep link preserving current and evidence scan IDs.

- [ ] **Step 1: Replace local lifecycle and flow implementations**

Delete local `LifecycleBadge`, `AttackFlow` and `FlowNode`. Import:

```ts
import { LifecycleBadge } from "../components/LifecycleBadge";
import { AttackPathPreview } from "../components/attack-path";
import { attackPathHref } from "../lib/attack-path";
```

- [ ] **Step 2: Wire the preview to context and baseline evidence**

Replace the `flow` branch in `FindingInspector`:

```tsx
{view === "flow" && <AttackPathPreview
  model={finding.attackPathModel}
  explorerHref={(laneId, nodeId) => attackPathHref({
    scanId: scan.id,
    findingId: finding.findingId,
    evidenceScanId: signal.sourceScanId,
    laneId,
    nodeId,
  })}
/>}
```

The Preview must use `signal.sourceScanId`, not always `scan.id`, so fixed findings open baseline evidence.

- [ ] **Step 3: Run types and production build**

Run:

```bash
pnpm --filter @csb/web typecheck
pnpm --filter @csb/web build
```

Expected: PASS. The existing Vite chunk-size warning is non-blocking; no new runtime error is acceptable.

- [ ] **Step 4: Browser smoke test the Inspector**

With dev servers running, open a rich finding and verify:

- Fluxo shows ordered nodes;
- clicking a node changes evidence;
- Expandir investigação includes `lane` and `node`; it includes `evidenceScan` exactly when `signal.sourceScanId !== scan.id`;
- a finding without model shows the empty state;
- triage and other tabs remain unchanged.

- [ ] **Step 5: Commit the Inspector integration if isolated**

```bash
git add apps/web/src/pages/ScanDetailPage.tsx
git diff --cached --check
git commit -m "feat: add attack path preview to inspector"
```

---

### Task 6: Dedicated Attack Explorer route

**Files:**
- Create: `apps/web/src/pages/AttackPathPage.tsx`
- Modify: `apps/web/src/App.tsx:11-72`

**Interfaces:**
- Consumes: `api.getScan`, `api.regression`, `api.getFinding`, `getAttackPathSelection`, `AttackPathStage`, `AttackPathEvidence`.
- Produces: reloadable `/scans/:id/findings/:findingId/path` route.

- [ ] **Step 1: Create the page loader and canonical selection**

The page must read `id`, `findingId`, `evidenceScan`, `lane`, and `node`; load context scan, regression and evidence in parallel:

```tsx
type AttackPathLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; scan: ScanRun; regression: RegressionSummary; finding: FindingDetail };

const { id = "", findingId = "" } = useParams();
const [params, setParams] = useSearchParams();
const [state, setState] = useState<AttackPathLoadState>({ status: "loading" });
const evidenceScanId = params.get("evidenceScan") ?? id;

useEffect(() => {
  let cancelled = false;
  setState({ status: "loading" });
  Promise.all([api.getScan(id), api.regression(id), api.getFinding(evidenceScanId, findingId)])
    .then(([context, regression, detail]) => {
      if (!cancelled) setState({ status: "ready", scan: context.scan, regression, finding: detail.finding });
    })
    .catch((error) => {
      if (!cancelled) setState({ status: "error", message: error instanceof Error ? error.message : "Falha ao carregar caminho" });
    });
  return () => { cancelled = true; };
}, [id, findingId, evidenceScanId]);
```

If `attackPathModel` is null or contains no nodes, render an error-safe empty state with a link back to `/scans/${id}?f=${findingId}`.

- [ ] **Step 2: Build the connected desktop/mobile layout**

Use this page structure:

```tsx
<div className="bench-panel bench-corners">
  <AttackPathHeader scanId={id} finding={state.finding} signal={signal} model={model} />
  <div className={cx("grid", model.lanes.length > 1 ? "lg:grid-cols-[14rem_minmax(0,1fr)_26rem]" : "lg:grid-cols-[minmax(0,1fr)_26rem]")}>
    {model.lanes.length > 1 && <PathIndex lanes={model.lanes} activeLaneId={selection.lane.id} onSelect={selectLane} />}
    <main className="min-w-0 border-b lg:border-b-0 lg:border-r">
      <AttackPathStage lane={selection.lane} selectedNodeId={selection.node.id} onSelectNode={selectNode} />
    </main>
    <aside className="min-w-0"><AttackPathEvidence node={selection.node} /></aside>
  </div>
</div>
```

Header content:

- back to current scan with `?f=findingId`;
- title, severity and lifecycle;
- baseline source and `validated|partial|unstructured` status;
- impact and likelihood only when provided.

Do not render an empty lane index when only `primary` exists.

Resolve lifecycle without guessing:

```ts
const signal = state.regression.findings.find((item) =>
  item.findingId === findingId && item.sourceScanId === evidenceScanId,
) ?? null;
```

Define `AttackPathHeader` and `PathIndex` as local components in `AttackPathPage.tsx`; do not create undeclared JSX placeholders:

```tsx
function PathIndex({ lanes, activeLaneId, onSelect }: {
  lanes: AttackPathLane[];
  activeLaneId: string;
  onSelect: (lane: AttackPathLane) => void;
}) {
  return <aside className="border-b lg:border-b-0 lg:border-r">
    <div className="bench-label border-b p-3">PATH INDEX</div>
    {lanes.map((lane, index) => <button
      key={lane.id}
      type="button"
      aria-pressed={lane.id === activeLaneId}
      onClick={() => onSelect(lane)}
      className={cx("w-full border-b p-3 text-left hover:bg-accent", lane.id === activeLaneId && "bg-accent text-primary")}
    >
      <span className="font-mono text-[8px]">{String(index + 1).padStart(2, "0")}</span>
      <strong className="ml-3 text-xs">{lane.label}</strong>
    </button>)}
  </aside>;
}

function AttackPathHeader({ scanId, finding, signal, model }: {
  scanId: string;
  finding: FindingDetail;
  signal: LifecycleFinding | null;
  model: AttackPathModel;
}) {
  return <header className="border-b p-4 sm:p-5">
    <Button asChild variant="ghost" size="sm"><Link to={`/scans/${scanId}?f=${encodeURIComponent(finding.findingId)}`}>Voltar ao finding</Link></Button>
    <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0"><div className="bench-label">ATTACK EXPLORER / {model.status}</div><h1 className="mt-2 font-heading text-2xl font-semibold sm:text-3xl">{finding.title}</h1></div>
      <div className="flex items-center gap-2">{signal && <LifecycleBadge state={signal.lifecycle} />}<SeverityBadge severity={finding.severity} /></div>
    </div>
  </header>;
}
```

- [ ] **Step 3: Keep selection in the URL**

Implement:

```ts
function selectNode(next: AttackPathNode) {
  const nextParams = new URLSearchParams(params);
  nextParams.set("lane", selection.lane.id);
  nextParams.set("node", next.id);
  setParams(nextParams, { replace: true });
}

function selectLane(next: AttackPathLane) {
  const nextNode = getAttackPathSelection(model, next.id, null).node;
  const nextParams = new URLSearchParams(params);
  nextParams.set("lane", next.id);
  nextParams.set("node", nextNode.id);
  setParams(nextParams, { replace: true });
}
```

After loading, if `lane` or `node` is invalid, replace them with canonical values from `getAttackPathSelection` while preserving `evidenceScan`.

- [ ] **Step 4: Register the route**

Import `AttackPathPage` in `App.tsx` and add:

```tsx
<Route path="/scans/:id/findings/:findingId/path" element={<AttackPathPage />} />
```

Keep the existing `/scans/:id` route. `NavStrip` already treats the new route as `Runs`; verify rather than rewriting its matching logic.

- [ ] **Step 5: Verify routing and failure states**

Run:

```bash
pnpm --filter @csb/web test
pnpm --filter @csb/web typecheck
pnpm --filter @csb/web build
```

Expected: PASS.

Browser cases:

1. direct reload of a valid Explorer URL;
2. invalid `lane` and `node` normalize without blank screen;
3. fixed finding loads `evidenceScan` but returns to current scan;
4. missing baseline artifact shows an explicit error and back link;
5. rich code does not widen the document.

- [ ] **Step 6: Commit the route if isolated**

```bash
git add apps/web/src/pages/AttackPathPage.tsx apps/web/src/App.tsx
git diff --cached --check
git commit -m "feat: add attack path explorer"
```

---

### Task 7: Accessibility, visual QA and final gates

**Files:**
- Modify only files from Tasks 4–6 when QA finds an in-scope defect.

**Interfaces:**
- Consumes: completed Preview and Explorer.
- Produces: evidence that keyboard, mobile, desktop, build and data states satisfy the spec.

- [ ] **Step 1: Read the browser validation skill**

```bash
cat /Users/marcos/.codex/skills/playwright/SKILL.md
command -v npx >/dev/null 2>&1
```

Expected: skill read completely; `npx` exists.

- [ ] **Step 2: Run deterministic gates**

```bash
pnpm --filter @csb/api test
pnpm --filter @csb/web test
pnpm typecheck
pnpm --filter @csb/web build
git diff --check
```

Expected: all tests and typechecks PASS; build succeeds; only the known non-blocking Vite chunk warning may remain.

- [ ] **Step 3: Validate desktop at 1600×1000**

Using the bundled Playwright wrapper, open the rich Contion finding, select `Fluxo`, click source, control and sink, expand to Explorer, and confirm the code/evidence changes each time. Capture:

```bash
playwright-cli resize 1600 1000
playwright-cli screenshot --filename=/private/tmp/csb-attack-path-desktop.png
```

Verify no overlap, clipped labels, horizontal document scroll or command dock collision.

- [ ] **Step 4: Validate tablet and mobile**

```bash
playwright-cli resize 1024 768
playwright-cli screenshot --filename=/private/tmp/csb-attack-path-tablet.png
playwright-cli resize 390 844
playwright-cli screenshot --filename=/private/tmp/csb-attack-path-mobile.png
```

At 390 px, verify vertical path order, readable state labels, usable node targets, local code overflow and visible return/expand actions.

- [ ] **Step 5: Validate keyboard and semantics**

Use Tab to reach every node and activate with Enter/Space. Verify:

- focus remains visible;
- `aria-pressed` follows selection;
- accessible names include label, evidence state and position;
- color is not the only state signal;
- reduced motion disables non-essential transitions.

- [ ] **Step 6: Check console and clean bounded QA artifacts**

```bash
rg -n "(ERROR|WARNING|Error:|Uncaught|Failed)" .playwright-cli/console-*.log || true
find .playwright-cli -maxdepth 2 -type f -print | sort
find .playwright-cli -maxdepth 2 -type f -delete
find .playwright-cli -depth -type d -empty -delete
```

Expected: only React DevTools info in development; no application error. Delete only files inventoried inside `.playwright-cli`; keep final screenshots in `/private/tmp` for the handoff.

- [ ] **Step 7: Re-run gates after any QA fix**

```bash
pnpm --filter @csb/api test
pnpm --filter @csb/web test
pnpm typecheck
pnpm --filter @csb/web build
git diff --check
git status --short
```

Expected: all gates PASS and the status contains only intentional implementation files plus pre-existing accepted changes.

- [ ] **Step 8: Commit final in-scope fixes if isolated**

Stage exact files changed during QA, inspect `git diff --cached`, then:

```bash
git diff --cached --check
git commit -m "fix: polish attack path workbench"
```

Do not commit unrelated dirty files merely to obtain a clean status.

---

## Final Acceptance Checklist

- [ ] Preview and Explorer render the same ordered `AttackPathModel`.
- [ ] Proven nodes reveal the exact linked code evidence.
- [ ] Inferred and missing states are labeled explicitly.
- [ ] No UI claims `unreachable` from absent evidence.
- [ ] Fixed findings use baseline evidence without losing current scan context.
- [ ] Deep links survive reload and normalize invalid selections.
- [ ] Inspector summary, evidence, correction and triage remain functional.
- [ ] Desktop, tablet and mobile pass visual QA without document overflow.
- [ ] Keyboard, focus, accessible names and reduced motion pass.
- [ ] API tests, web tests, typecheck, production build and `git diff --check` pass.
