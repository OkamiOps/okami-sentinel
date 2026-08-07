import assert from "node:assert/strict";
import test from "node:test";

import type { GuardrailGitHubStatus } from "@csb/shared";

import { githubSetupModel, prCheckLabel } from "./github-guardrails.js";

function statusFixture(overrides: {
  cliReady?: boolean;
  remoteReady?: boolean;
  authReady?: boolean;
  permissionsReady?: boolean;
  secretReady?: boolean;
  workflowReady?: boolean;
  baselineReady?: boolean;
  subscriptionReady?: boolean;
} = {}): GuardrailGitHubStatus {
  const capability = (ready: boolean, message: string, action: string | null) => ({ ready, message, action });
  const cliReady = overrides.cliReady ?? true;
  const remoteReady = overrides.remoteReady ?? true;
  const authReady = overrides.authReady ?? true;
  const permissionsReady = overrides.permissionsReady ?? true;
  const secretReady = overrides.secretReady ?? true;
  const workflowReady = overrides.workflowReady ?? true;
  const baselineReady = overrides.baselineReady ?? true;
  const subscriptionReady = overrides.subscriptionReady ?? true;

  return {
    subscription: capability(subscriptionReady, subscriptionReady ? "Assinatura Codex local detectada" : "Sessão Codex ausente", subscriptionReady ? null : "Execute codex login"),
    cli: { ...capability(cliReady, cliReady ? "gh disponível" : "gh indisponível", cliReady ? null : "Instale gh"), available: cliReady },
    remote: capability(remoteReady, remoteReady ? "remote pronto" : "remote ausente", remoteReady ? null : "Configure o remote"),
    auth: capability(authReady, authReady ? "autenticação pronta" : "gh sem autenticação", authReady ? null : "Execute gh auth login"),
    permissions: capability(permissionsReady, permissionsReady ? "permissões prontas" : "permissões insuficientes", permissionsReady ? null : "Conceda acesso"),
    secret: capability(secretReady, secretReady ? "OPENAI_API_KEY configurada" : "OPENAI_API_KEY ausente", secretReady ? null : "Configure OPENAI_API_KEY"),
    workflow: capability(workflowReady, workflowReady ? "workflow pronto" : "workflow ausente", workflowReady ? null : "Instale o workflow"),
    baseline: capability(baselineReady, baselineReady ? "baseline pronta" : "baseline ausente", baselineReady ? null : "Sincronize a baseline"),
    ready: cliReady && remoteReady && authReady && permissionsReady && secretReady && workflowReady && baselineReady,
  };
}

test("shows the first blocking capability with a specific action", () => {
  const model = githubSetupModel(statusFixture({ authReady: false, workflowReady: false }));
  assert.equal(model.primary.title, "Autentique o gh CLI");
  assert.equal(model.primary.command, "gh auth login");
});

test("does not claim ready when the scanner secret is missing", () => {
  const model = githubSetupModel(statusFixture({ secretReady: false }), undefined, "api");
  assert.equal(model.ready, false);
  assert.match(model.steps.find((step) => step.id === "secret")?.message ?? "", /OPENAI_API_KEY/);
});

test("subscription mode does not require an API secret or caller workflow", () => {
  const model = githubSetupModel(
    statusFixture({ secretReady: false, workflowReady: false, subscriptionReady: true }),
    undefined,
    "subscription",
  );
  assert.equal(model.ready, true);
  assert.equal(model.steps.some((step) => step.id === "secret"), false);
  assert.equal(model.steps.some((step) => step.id === "workflow"), false);
  assert.equal(model.steps.find((step) => step.id === "scanner")?.ready, true);
});

test("subscription mode asks for a Codex login instead of an API key", () => {
  const model = githubSetupModel(
    statusFixture({ secretReady: false, subscriptionReady: false }),
    undefined,
    "subscription",
  );
  assert.equal(model.ready, false);
  assert.equal(model.primary.title, "Use sua assinatura Codex");
  assert.equal(model.primary.command, "codex login");
});

test("maps publication states without changing the security outcome", () => {
  assert.equal(prCheckLabel({ outcome: "blocked", publishStatus: "failed" }), "PUBLICAÇÃO FALHOU");
});
