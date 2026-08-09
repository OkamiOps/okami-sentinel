# Security Change Gate GitHub Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Executar o mesmo Security Change Gate no GitHub Actions, publicar um Check explicável, sincronizar baselines remotos e operar setup/publicação pelo app local sem armazenar tokens.

**Architecture:** Um CLI headless usa `@csb/gate-runtime` e `@csb/gate-core` para produzir o mesmo GateArtifact do app local. Um reusable workflow versionado executa o CLI e publica o Check; a API local usa `gh` CLI para diagnóstico, instalação do caller workflow, download de baseline e publicação opcional de preflights locais.

**Tech Stack:** TypeScript 5.8, Node.js 24.17, pnpm workspaces, GitHub Actions, `gh` CLI, GitHub Checks API, Hono, React 19, Shadcn, DaisyUI, node:test.

## Global Constraints

- Este plano começa somente depois do Local Release Gate de `2026-08-07-security-change-gate-local.md` estar aprovado e commitado.
- O CLI, a API e o workflow usam o mesmo `@csb/gate-core`; nenhum adapter reimplementa policy evaluation.
- O CLI e a API reutilizam `@csb/gate-runtime` para Git diff e arquivos de política.
- O app nunca armazena ou imprime `gh auth token`, `OPENAI_API_KEY` ou outro secret.
- O caller workflow referencia uma release imutável `@v1`; não referencia `@main`.
- Workflow de fork sem secret retorna `action_required` ou estado não publicado; nunca `success`.
- Usar permissões mínimas: `contents: read`, `pull-requests: read`, `actions: read`, `checks: write`.
- O workflow escreve artifacts mesmo quando o gate bloqueia ou falha.
- O Check limita anotações ao primeiro conjunto determinístico de 20 findings por severidade, lifecycle e identidade.
- Todo subprocesso local usa `execFile`/`spawn` com arrays de argumentos e `shell: false`.
- Antes da Task 6, ler e aplicar `frontend-design`, `impeccable` e `ui-ux-pro-max`.
- Não criar CSS global novo; usar Shadcn/DaisyUI, tokens existentes e Tailwind.
- Seguir TDD e criar um commit isolado por tarefa.

---

## File Map

### Create

- `apps/gate-cli/package.json` — workspace headless.
- `apps/gate-cli/tsconfig.json` — TypeScript do CLI.
- `apps/gate-cli/src/args.ts` — argumentos validados.
- `apps/gate-cli/src/scanner.ts` — adapter do Codex Security CLI.
- `apps/gate-cli/src/run.ts` — pipeline headless e códigos de saída.
- `apps/gate-cli/src/index.ts` — entrypoint sem lógica de domínio.
- `apps/gate-cli/src/*.test.ts` — testes com scanner falso.
- `.github/workflows/security-change-gate.yml` — reusable workflow.
- `.github/workflows/fixtures/caller.yml` — caller validado usado pelo gerador.
- `apps/api/src/github-cli.ts` — adapter `gh` injetável.
- `apps/api/src/github-status.ts` — diagnóstico por capability.
- `apps/api/src/github-workflow.ts` — caller workflow local.
- `apps/api/src/github-baseline.ts` — localizar, baixar e validar artifact.
- `apps/api/src/github-check.ts` — publicar Check local.
- `apps/api/src/github-*.test.ts` — adapters com runner falso.
- `apps/web/src/components/guardrails/GitHubStatusPanel.tsx` — diagnóstico e ações.
- `apps/web/src/components/guardrails/PublishGateControl.tsx` — publicação/retry.
- `apps/web/src/pages/GuardrailSetupPage.tsx` — enrollment remoto.
- `apps/web/src/lib/github-guardrails.ts` — view model de capabilities.
- `apps/web/src/lib/github-guardrails.test.ts` — estados e mensagens.

### Modify

- `pnpm-lock.yaml` — workspace do CLI.
- `packages/shared/src/index.ts` — capabilities GitHub e metadata de publicação.
- `apps/api/package.json` — dependências internas.
- `apps/api/src/app.ts` — status, instalação, baseline e publicação.
- `apps/api/src/gate-store.ts` — cache remoto e publish status.
- `apps/api/src/gate-orchestrator.ts` — `BaselineProvider` remoto opcional.
- `apps/web/src/App.tsx` — rota setup.
- `apps/web/src/api.ts` — endpoints GitHub.
- `apps/web/src/pages/GuardrailsPage.tsx` — coluna PR Check real.
- `apps/web/src/components/guardrails/index.ts` — exports.
- `README.md` — instalação Actions, secret e branch protection.

---

### Task 1: Headless gate CLI

**Files:**
- Create: `apps/gate-cli/package.json`
- Create: `apps/gate-cli/tsconfig.json`
- Create: `apps/gate-cli/src/args.ts`
- Create: `apps/gate-cli/src/scanner.ts`
- Create: `apps/gate-cli/src/run.ts`
- Create: `apps/gate-cli/src/index.ts`
- Create: `apps/gate-cli/src/run.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `@csb/gate-core`, `@csb/gate-runtime`, repository checkout, policy path, optional baseline artifact and scanner credential from environment.
- Produces: `runGateCli(options, deps?)`, `csb-gate-result.json`, exit codes `0 | 2 | 3`.

- [ ] **Step 1: Create the CLI scaffold and write contract tests**

Create `apps/gate-cli/package.json` with the exact manifest shown in Step 3, add the root-convention `tsconfig.json`, and create an empty `src/index.ts`. Run `pnpm install` under Node 24.17.0 so the workspace filter resolves. Do not implement args, scanner or run logic yet. Then add the failing tests:

```ts
test("writes a blocked artifact and returns exit code 2", async () => {
  const output = tempOutput();
  const result = await runGateCli(options({ output }), fakeDeps({ outcome: "blocked" }));
  assert.equal(result.exitCode, 2);
  const artifact = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.equal(artifact.decision.outcome, "blocked");
  assert.equal(artifact.schemaVersion, 1);
});

test("returns exit code 3 and writes an error artifact when the scanner fails", async () => {
  const output = tempOutput();
  const result = await runGateCli(options({ output }), fakeDeps({ scannerError: "OPENAI_API_KEY ausente" }));
  assert.equal(result.exitCode, 3);
  assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).decision.outcome, "error");
});

test("returns zero for pass, warning, bootstrap and no_changes", async () => {
  for (const outcome of ["pass", "warning", "bootstrap", "no_changes"] as const) {
    const result = await runGateCli(options({ output: tempOutput() }), fakeDeps({ outcome }));
    assert.equal(result.exitCode, 0);
  }
});
```

- [ ] **Step 2: Run the CLI test and verify the implementation is missing**

Run: `pnpm --filter @csb/gate-cli test`

Expected: FAIL because the CLI modules do not exist; the test runner must report `run.test.ts` rather than `No projects matched`.

- [ ] **Step 3: Create the CLI workspace and validated arguments**

The `apps/gate-cli/package.json` scaffold created in Step 1 must contain exactly:

```json
{
  "name": "@csb/gate-cli",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "csb-gate": "./src/index.ts" },
  "scripts": {
    "start": "tsx src/index.ts",
    "test": "tsx --test src/*.test.ts",
    "typecheck": "tsc --noEmit",
    "build": "tsc --noEmit"
  },
  "dependencies": {
    "@csb/gate-core": "workspace:*",
    "@csb/gate-runtime": "workspace:*",
    "@csb/shared": "workspace:*"
  },
  "devDependencies": { "@types/node": "^22.15.32", "tsx": "^4.23.1", "typescript": "^5.8.3" }
}
```

`parseArgs(argv)` must require:

- `--repository`
- `--base-ref`
- `--head-ref`
- `--policy`
- `--output`
- `--repository-key`
- `--repository-name`
- `--default-branch`

It accepts optional `--owner`, `--baseline`, `--gate-id` and `--pull-request`. Reject unknown flags, missing values and non-numeric pull request values.

- [ ] **Step 4: Implement the scanner adapter and headless pipeline**

Define:

```ts
export interface ScannerResult {
  scanId: string;
  scanDir: string;
  status: "completed" | "failed";
  findings: FindingSummary[];
  cost: ScanCost | null;
  scannerVersion: string | null;
}

export interface ScannerAdapter {
  run(input: { repositoryPath: string; paths: string[]; policy: GuardrailPolicy; outputDir: string }): Promise<ScannerResult>;
}
```

The default adapter spawns:

```ts
const args = [
  "--yes", "@openai/codex-security", "scan", repositoryPath,
  "--model", policy.scan.model,
  "--effort", policy.scan.effort,
  "--mode", policy.scan.mode,
  "--max-cost", String(policy.scan.maxCostUsd),
  "--output-dir", outputDir,
  "--json",
];
for (const changedPath of paths) args.push("--path", changedPath);
spawn("npx", args, { cwd: repositoryPath, env: { ...process.env, CI: "1", NO_COLOR: "1" }, shell: false });
```

`runGateCli` resolves the change set, reads policy/exceptions, loads and validates optional baseline artifact, runs the scanner only when changes exist, evaluates through gate core, writes the artifact atomically, and returns:

- `0` for no_changes/bootstrap/pass/warning;
- `2` for blocked;
- `3` for error.

Wrap the pipeline after argument validation. On scanner, policy, baseline or evaluation failure, sanitize the message, call `buildOperationalErrorArtifact` with the already resolved public-safe change set, and atomically write it before returning `3`. The workflow supplies base/head commit SHAs, so a failure before Git resolution uses those validated SHA arguments to form an empty error change set; it never substitutes branch names for SHAs. Argument errors that prevent identifying a repository or head SHA exit `3` with stderr and no fabricated artifact.

The entrypoint sets `process.exitCode` from the returned value and prints only outcome, artifact path, cost and finding counts.

- [ ] **Step 5: Run CLI gates**

Run:

```bash
pnpm --filter @csb/gate-cli test
pnpm --filter @csb/gate-cli typecheck
pnpm --filter @csb/gate-cli build
```

Expected: all CLI tests pass and no scanner secret appears in captured output.

- [ ] **Step 6: Commit the CLI**

```bash
git add apps/gate-cli pnpm-lock.yaml
git commit -m "feat: add headless security gate cli"
```

---

### Task 2: Reusable GitHub workflow and caller template

**Files:**
- Create: `.github/workflows/security-change-gate.yml`
- Create: `.github/workflows/fixtures/caller.yml`
- Create: `apps/gate-cli/src/workflow-contract.test.ts`

**Interfaces:**
- Consumes: pull_request/push context, `OPENAI_API_KEY`, policy file and versioned CSB ref.
- Produces: custom Check `CSB Security Change Gate`, Step Summary and artifact `csb-gate-artifact`.

- [ ] **Step 1: Write a workflow contract test**

Parse the YAML as text without adding a YAML dependency and assert:

```ts
test("workflow has bounded permissions, immutable tool ref and unconditional artifact upload", () => {
  const workflow = fs.readFileSync(workflowPath, "utf8");
  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /pull-requests:\s*read/);
  assert.match(workflow, /actions:\s*read/);
  assert.match(workflow, /checks:\s*write/);
  assert.match(workflow, /ref:\s*\$\{\{ inputs\.csb_ref \}\}/);
  assert.match(workflow, /if:\s*always\(\)/);
  assert.doesNotMatch(workflow, /@main/);
});
```

- [ ] **Step 2: Run the contract test and verify workflow absence**

Run: `pnpm --filter @csb/gate-cli test`

Expected: FAIL because the workflow does not exist.

- [ ] **Step 3: Create the reusable workflow**

Define `workflow_call` inputs:

- `policy_path`, default `.csb/guardrails.json`;
- `csb_ref`, default `v1`;
- `default_branch`, default `main`;

Define secret `OPENAI_API_KEY` as optional so missing authentication can produce an artifact and `action_required` instead of preventing job creation.

The job must:

1. checkout the caller repository into the workspace;
2. checkout `OkamiOps/okami-sentinel` at `${{ inputs.csb_ref }}` into `.csb-tool`;
3. set up Node 24 and pnpm 11.5.2;
4. run `pnpm --dir .csb-tool install --frozen-lockfile --filter @csb/gate-cli...` so only the CLI and its workspace dependency closure are installed;
5. derive base/head SHAs from the event;
6. run the CLI while capturing its exit code without aborting artifact publication;
7. upload `csb-gate-result.json` with `if: always()`;
8. write a Step Summary;
9. publish the custom Check from the artifact with `actions/github-script`;
10. fail the final step only for CLI exit `2` or `3`, after the Check exists.

The Check maps the artifact conclusion exactly and includes at most 20 annotations sorted by severity, lifecycle and identity. Every annotation path must be repository-relative.

Create a caller fixture using:

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

- [ ] **Step 4: Run workflow contract and CLI tests**

Run: `pnpm --filter @csb/gate-cli test`

Expected: workflow contract and CLI tests pass.

- [ ] **Step 5: Commit workflows**

```bash
git add .github/workflows apps/gate-cli/src/workflow-contract.test.ts
git commit -m "feat: add reusable github security gate workflow"
```

---

### Task 3: Safe `gh` adapter, diagnostics and caller installation

**Files:**
- Create: `apps/api/src/github-cli.ts`
- Create: `apps/api/src/github-cli.test.ts`
- Create: `apps/api/src/github-status.ts`
- Create: `apps/api/src/github-status.test.ts`
- Create: `apps/api/src/github-workflow.ts`
- Create: `apps/api/src/github-workflow.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: enrolled repository path and fixture caller workflow.
- Produces: `GhRunner`, `GitHubCapabilityStatus`, `GuardrailGitHubStatus`, `getGitHubStatus(repo)`, `installCallerWorkflow(repo, options)`.

- [ ] **Step 1: Write capability and installation tests**

```ts
test("reports each github capability independently", async () => {
  const status = await getGitHubStatus(repository(), fakeGh({ authenticated: true, secretNames: ["OPENAI_API_KEY"], workflowInstalled: false }));
  assert.equal(status.cli.available, true);
  assert.equal(status.auth.ready, true);
  assert.equal(status.secret.ready, true);
  assert.equal(status.workflow.ready, false);
});

test("writes a versioned caller workflow without committing it", async () => {
  const repo = tempGitRepo();
  const result = await installCallerWorkflow(repo, { defaultBranch: "main", secretName: "OPENAI_API_KEY" });
  const body = fs.readFileSync(result.path, "utf8");
  assert.match(body, /@v1/);
  assert.doesNotMatch(body, /@main/);
  assert.equal(result.committed, false);
});
```

- [ ] **Step 2: Run API tests and verify missing adapters**

Run: `pnpm --filter @csb/api test`

Expected: FAIL because GitHub adapters do not exist.

- [ ] **Step 3: Implement an injected `gh` runner**

```ts
export interface GhResult { stdout: string; stderr: string; exitCode: number; }
export type GhRunner = (args: string[], options: { cwd: string; stdin?: string }) => Promise<GhResult>;

export const defaultGhRunner: GhRunner = (args, options) => new Promise((resolve, reject) => {
  const child = spawn("gh", args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], shell: false });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.on("error", reject);
  child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
  child.stdin.end(options.stdin ?? "");
});
```

Never call `gh auth token`. Diagnostics use:

- `gh --version`;
- `gh auth status`;
- `gh repo view --json nameWithOwner,defaultBranchRef`;
- `gh api repos/<owner>/<repository> --jq .permissions` to distinguish read-only from push/admin access needed by local Check publication;
- `gh api repos/<owner>/<repository>/actions/permissions/workflow` to verify the repository Actions policy;
- `gh secret list --json name`;
- local filesystem check for `.github/workflows/csb-security-change-gate.yml`.

Return each capability with `{ ready, message, action }`. Installation writes the exact caller fixture to the target repo with its configured branch/secret and returns the path; it does not run Git commit or push.

Append these transport contracts to `packages/shared/src/index.ts` and use them in API responses and the later setup UI:

```ts
export interface GitHubCapabilityStatus {
  ready: boolean;
  message: string;
  action: string | null;
}

export interface GuardrailGitHubStatus {
  cli: GitHubCapabilityStatus & { available: boolean };
  remote: GitHubCapabilityStatus;
  auth: GitHubCapabilityStatus;
  permissions: GitHubCapabilityStatus;
  secret: GitHubCapabilityStatus;
  workflow: GitHubCapabilityStatus;
  baseline: GitHubCapabilityStatus;
  ready: boolean;
}
```

- [ ] **Step 4: Run GitHub adapter tests**

Run:

```bash
pnpm --filter @csb/api test
pnpm --filter @csb/api typecheck
```

Expected: capability states and safe workflow installation pass.

- [ ] **Step 5: Commit GitHub diagnostics**

```bash
git add packages/shared/src/index.ts apps/api/src/github-cli.ts apps/api/src/github-cli.test.ts apps/api/src/github-status.ts apps/api/src/github-status.test.ts apps/api/src/github-workflow.ts apps/api/src/github-workflow.test.ts
git commit -m "feat: diagnose and install github guardrails"
```

---

### Task 4: Remote baseline provider and cache

**Files:**
- Create: `apps/api/src/github-baseline.ts`
- Create: `apps/api/src/github-baseline.test.ts`
- Modify: `apps/api/src/gate-store.ts`
- Modify: `apps/api/src/gate-store.test.ts`
- Modify: `apps/api/src/gate-orchestrator.ts`
- Modify: `apps/api/src/gate-orchestrator.test.ts`

**Interfaces:**
- Consumes: `GhRunner`, repository owner/name/default branch and GateArtifact parser.
- Produces: `BaselineProvider`, `GitHubBaselineProvider`, cached remote baseline metadata.

- [ ] **Step 1: Write baseline selection and rejection tests**

```ts
test("downloads the newest eligible default-branch artifact", async () => {
  const provider = new GitHubBaselineProvider(fakeGhRuns([run("new", "main"), run("old", "main")]), cacheDir());
  const baseline = await provider.getBaseline(repositoryContext());
  assert.equal(baseline?.changeSet.headSha, "new");
});

test("rejects an artifact with a future schema", async () => {
  const provider = new GitHubBaselineProvider(fakeGhArtifact({ schemaVersion: 2 }), cacheDir());
  await assert.rejects(() => provider.getBaseline(repositoryContext()), /GateArtifact schema 2 não suportado/);
});

test("returns null when no default-branch artifact exists", async () => {
  const provider = new GitHubBaselineProvider(fakeGhRuns([]), cacheDir());
  assert.equal(await provider.getBaseline(repositoryContext()), null);
});

test("returns an operational error when run history exists but its artifacts are unavailable", async () => {
  const provider = new GitHubBaselineProvider(fakeGhRunsWithDownloadFailure([run("new", "main")]), cacheDir());
  await assert.rejects(() => provider.getBaseline(repositoryContext()), /histórico encontrado, mas o artifact de baseline não está disponível/);
});
```

- [ ] **Step 2: Run tests and verify missing provider**

Run: `pnpm --filter @csb/api test`

Expected: FAIL because the provider does not exist.

- [ ] **Step 3: Add cache schema and artifact lookup**

Add:

```sql
CREATE TABLE IF NOT EXISTS github_baselines (
  repository_key TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
```

Lookup sequence:

```text
gh run list --branch <default> --workflow csb-security-change-gate.yml --limit 20 --json databaseId,headSha,createdAt
gh run download <databaseId> --name csb-gate-artifact --dir <workspace-data-cache>/<repositoryKey>/<databaseId>
```

Validate every downloaded JSON with `parseGateArtifact` before caching. Ignore artifacts whose decision outcome is `error` or whose run was cancelled; `bootstrap` is eligible when it contains a completed, valid finding set for the exact default-branch head SHA. Return the first eligible newest artifact. If the run list is empty, return `null` so the gate bootstraps. If runs exist but every artifact is expired, unavailable, malformed or ineligible, throw `BaselineUnavailableError`; the orchestrator maps it to `error/action_required` and never silently bootstraps. Keep cache under `data/github-cache`, never under global `/tmp`.

Define:

```ts
export interface BaselineProvider {
  getBaseline(context: { repositoryKey: string; owner: string; name: string; defaultBranch: string }): Promise<GateArtifact | null>;
}
```

The local orchestrator keeps its current local provider. Use the GitHub provider only when the repository has a ready remote and the request asks for `baselineSource: "github"`.

- [ ] **Step 4: Run store, provider and orchestrator tests**

Run:

```bash
pnpm --filter @csb/api test
pnpm --filter @csb/api typecheck
```

Expected: newest valid artifact is selected; future schema is rejected; local provider tests remain green.

- [ ] **Step 5: Commit remote baseline support**

```bash
git add apps/api/src/github-baseline.ts apps/api/src/github-baseline.test.ts apps/api/src/gate-store.ts apps/api/src/gate-store.test.ts apps/api/src/gate-orchestrator.ts apps/api/src/gate-orchestrator.test.ts
git commit -m "feat: sync github guardrail baselines"
```

---

### Task 5: GitHub Check publication and HTTP endpoints

**Files:**
- Create: `apps/api/src/github-check.ts`
- Create: `apps/api/src/github-check.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/guardrails.test.ts`
- Modify: `apps/api/src/gate-store.ts`
- Modify: `apps/api/src/gate-store.test.ts`
- Modify: `apps/web/src/api.ts`

**Interfaces:**
- Consumes: validated GateArtifact, repository remote and `GhRunner` with stdin.
- Produces: `publishGateCheck(input)`, `recordGatePublicationAttempt`, `listGatePublicationAttempts`, status/install/publish/baseline API methods.

- [ ] **Step 1: Write payload and endpoint tests**

```ts
test("publishes a failure check for a blocked gate", async () => {
  const gh = recordingGh();
  await publishGateCheck({ artifact: blockedArtifact(), owner: "OkamiOps", repository: "okami-sentinel", detailsUrl: null }, gh);
  const payload = JSON.parse(gh.lastStdin ?? "{}");
  assert.equal(payload.name, "CSB Security Change Gate");
  assert.equal(payload.conclusion, "failure");
  assert.equal(payload.head_sha, blockedArtifact().changeSet.headSha);
  assert.ok(payload.output.summary.includes("High reaberto"));
});

test("never publishes absolute local paths", async () => {
  const gh = recordingGh();
  await publishGateCheck({ artifact: blockedArtifact(), owner: "OkamiOps", repository: "CSB", detailsUrl: null }, gh);
  assert.equal((gh.lastStdin ?? "").includes("/Users/"), false);
});

test("POST publish keeps the local outcome when github fails", async () => {
  const response = await testApp.request("/guardrails/gates/gate-1/publish", { method: "POST" });
  assert.equal(response.status, 502);
  assert.equal(store.getGateRun("gate-1")?.outcome, "blocked");
  assert.equal(store.getGateRun("gate-1")?.publishStatus, "failed");
  assert.match(store.getGateRun("gate-1")?.publishError ?? "", /github/i);
  assert.deepEqual(store.listGatePublicationAttempts("gate-1").map((attempt) => attempt.status), ["failed"]);
});
```

- [ ] **Step 2: Run tests and verify missing publisher**

Run: `pnpm --filter @csb/api test`

Expected: FAIL because publisher and routes are missing.

- [ ] **Step 3: Implement Check payload and safe publication**

Call:

```text
gh api --method POST repos/<owner>/<repository>/check-runs --input -
```

Send JSON through stdin. Include:

- name `CSB Security Change Gate`;
- head SHA;
- status `completed`;
- mapped conclusion;
- title, summary and text;
- at most 20 repository-relative annotations.

Sort annotations by severity rank `critical, high, medium, low, info, unknown`, then lifecycle `new, reopened, persistent, fixed`, then identity. Publication errors update only publish metadata/error, not security outcome.

Append this contract to `packages/shared/src/index.ts` and add the three fields to the existing `GateRun` interface:

```ts
export type GatePublishStatus = "not_configured" | "waiting" | "publishing" | "published" | "failed";
```

Inside the existing `GateRun` interface, insert exactly `publishStatus: GatePublishStatus`, `publishError: string | null` and `publishedAt: string | null`; do not redeclare or replace its local fields.

Add `publish_status TEXT NOT NULL DEFAULT 'not_configured'`, `publish_error TEXT` and `published_at TEXT` to the `gate_runs` table definition. Because users can already have the local schema, `ensureGateSchema` must inspect `PRAGMA table_info(gate_runs)` and add each absent column with an idempotent `ALTER TABLE`; cover both a fresh database and a database created from the local-plan schema in `gate-store.test.ts`.

Create an additive retry ledger:

```sql
CREATE TABLE IF NOT EXISTS gate_publication_attempts (
  id TEXT PRIMARY KEY,
  gate_id TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS gate_publication_attempts_by_gate
  ON gate_publication_attempts(gate_id, created_at DESC);
```

Every publish request inserts one `publishing` attempt and finalizes that row as `published` or `failed`. Retrying creates a new row; it never overwrites prior attempts.

Add endpoints:

- `GET /guardrails/repositories/:repositoryKey/github-status`
- `POST /guardrails/repositories/:repositoryKey/install-workflow`
- `POST /guardrails/repositories/:repositoryKey/baseline/sync`
- `POST /guardrails/gates/:gateId/publish`

Return 409 for a gate without artifact, 400 for a repository without GitHub remote and 502 for `gh` failure.

- [ ] **Step 4: Add typed web API methods and run gates**

Run:

```bash
pnpm --filter @csb/api test
pnpm --filter @csb/web test
pnpm typecheck
```

Expected: payload, path redaction and outcome preservation tests pass.

- [ ] **Step 5: Commit publisher and endpoints**

```bash
git add packages/shared/src/index.ts apps/api/src/github-check.ts apps/api/src/github-check.test.ts apps/api/src/app.ts apps/api/src/guardrails.test.ts apps/api/src/gate-store.ts apps/api/src/gate-store.test.ts apps/web/src/api.ts
git commit -m "feat: publish guardrail checks to github"
```

---

### Task 6: GitHub setup and publication UI

**Files:**
- Create: `apps/web/src/lib/github-guardrails.ts`
- Create: `apps/web/src/lib/github-guardrails.test.ts`
- Create: `apps/web/src/components/guardrails/GitHubStatusPanel.tsx`
- Create: `apps/web/src/components/guardrails/PublishGateControl.tsx`
- Create: `apps/web/src/pages/GuardrailSetupPage.tsx`
- Modify: `apps/web/src/components/guardrails/index.ts`
- Modify: `apps/web/src/pages/GuardrailsPage.tsx`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: GitHub capability status, install/sync/publish endpoints and GateArtifact publication state.
- Produces: `/guardrails/setup` and real PR Check stage in the Portfolio Pipeline.

- [ ] **Step 1: Read frontend skills and write capability view-model tests**

```ts
test("shows the first blocking capability with a specific action", () => {
  const model = githubSetupModel(statusFixture({ authReady: false, workflowReady: false }));
  assert.equal(model.primary.title, "Autentique o gh CLI");
  assert.equal(model.primary.command, "gh auth login");
});

test("does not claim ready when the scanner secret is missing", () => {
  const model = githubSetupModel(statusFixture({ secretReady: false }));
  assert.equal(model.ready, false);
  assert.match(model.steps.find((step) => step.id === "secret")?.message ?? "", /OPENAI_API_KEY/);
});

test("maps publication states without changing the security outcome", () => {
  assert.equal(prCheckLabel({ outcome: "blocked", publishStatus: "failed" }), "PUBLICAÇÃO FALHOU");
});
```

- [ ] **Step 2: Run web tests and verify missing helpers**

Run: `pnpm --filter @csb/web test`

Expected: FAIL because GitHub setup helpers do not exist.

- [ ] **Step 3: Implement setup diagnostics**

Before editing, read `frontend-design`, `impeccable` and `ui-ux-pro-max` completely.

The setup page shows separate rows for:

- Git repository;
- GitHub remote;
- `gh` availability;
- authentication;
- Actions/Checks permission;
- scanner secret name;
- caller workflow;
- remote baseline.

Each row has state, exact message and one action. `Instalar workflow` opens a confirmation dialog naming the exact target path. After writing, show `Arquivo criado; revise e faça commit` and never claim it was pushed.

Add `PublishGateControl` to a completed local gate. It displays the exact owner/repo/head SHA and asks confirmation before publication. Failure keeps the blocked/pass outcome visible and offers retry.

Portfolio Pipeline PR Check values are `NOT CONFIGURED`, `WAITING`, `PUBLISHING`, `PUBLISHED`, `PUBLICATION FAILED`; none replaces the Decision outcome.

- [ ] **Step 4: Run frontend gates**

Run:

```bash
pnpm --filter @csb/web test
pnpm --filter @csb/web typecheck
pnpm --filter @csb/web build
```

Expected: setup and publication view models pass and Vite builds all routes.

- [ ] **Step 5: Commit GitHub UI**

```bash
git add apps/web/src/lib/github-guardrails.ts apps/web/src/lib/github-guardrails.test.ts apps/web/src/components/guardrails apps/web/src/pages/GuardrailSetupPage.tsx apps/web/src/pages/GuardrailsPage.tsx apps/web/src/App.tsx
git commit -m "feat: add github guardrail setup and publishing ui"
```

---

### Task 7: End-to-end validation and documentation

**Files:**
- Modify: `README.md`
- Verify: `.github/workflows/security-change-gate.yml`
- Verify: implementation and test files from Tasks 1–6.

**Interfaces:**
- Consumes: completed local gate, CLI, reusable workflow, GitHub adapters and UI.
- Produces: validated hybrid Guardrails release candidate.

- [ ] **Step 1: Run all deterministic gates under Node 24.17.0**

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Expected: all commands exit 0.

If a deterministic gate fails, stop Task 7 and return to the task that owns the defect. Do not make opportunistic implementation edits inside this validation task.

- [ ] **Step 2: Run CLI fixture scenarios**

Use temporary Git repositories and a fake scanner executable through the CLI dependency boundary. Validate artifacts and exit codes for:

- no_changes → 0/success;
- bootstrap → 0/neutral;
- pass → 0/success;
- warning → 0/neutral;
- blocked → 2/failure;
- missing credential → 3/action_required;
- malformed future baseline → 3/action_required.

Expected: every artifact passes schema validation and contains no absolute local path or secret.

- [ ] **Step 3: Validate `gh` against a non-production test repository**

Read-only first:

```bash
gh auth status
gh repo view --json nameWithOwner,defaultBranchRef
gh secret list --json name
```

Do not create, commit, push or publish until the exact test repository is confirmed in the UI. After confirmation:

- install the caller workflow locally;
- inspect its diff;
- commit/push only if the user explicitly authorizes the external repository change;
- trigger one test PR workflow;
- verify custom Check conclusion and artifact;
- sync the resulting baseline into the app.

If external authorization is not granted, mark this live gate blocked and keep deterministic validation green; do not claim GitHub end-to-end completion.

- [ ] **Step 4: Run browser validation at 390px, 1024px and 1600px**

Validate:

- setup capability states;
- workflow confirmation and success copy;
- Portfolio Pipeline PR Check states;
- publication confirmation, success, failure and retry;
- remote baseline bootstrap and synced states;
- keyboard navigation;
- no overlap, clipping or document-level horizontal overflow;
- no product console errors or warnings.

- [ ] **Step 5: Update documentation**

Document:

- prerequisites: Node 24.17, pnpm 11.5.2, `gh`, GitHub Actions and `OPENAI_API_KEY` secret;
- policy and exception files;
- caller workflow;
- immutable `@v1` requirement;
- required branch protection check name;
- outcome/conclusion mapping;
- fork behavior;
- baseline artifact retention behavior;
- local-only operation when GitHub is unavailable;
- troubleshooting by capability.

- [ ] **Step 6: Commit validated integration**

```bash
git add README.md
git commit -m "docs: complete github guardrail integration guide"
```

---

## GitHub Release Gate

This plan is complete only when:

- Local Release Gate remains green;
- CLI outcome/exit-code matrix passes;
- reusable workflow uses immutable refs and bounded permissions;
- artifact upload runs on pass, warning, blocked and error;
- custom Check conclusion matches GateArtifact;
- missing secrets and fork restrictions never produce success;
- remote baseline validates schema before caching;
- publication failure never changes the local security outcome;
- setup UI names the exact failed capability;
- live GitHub E2E is either proven on an authorized test repository or reported explicitly as externally blocked;
- all work is committed in isolated task commits.
