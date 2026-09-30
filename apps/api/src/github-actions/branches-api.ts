import { Hono } from "hono";
import type { GuardrailRepository } from "@csb/shared";

import { canSeeRepository, principalOf } from "../auth/principal.js";

/**
 * `GET /github/branches` — the live branches of one enrolled repository, which is
 * what the branch pickers in **Guardrails** (enrolment, preflight, the Actions
 * panel) read, not only the GitHub tab. It is the same read the poller's
 * `/github-monitor/branches` served; the path moves with the model, the answer
 * does not (`{ branches }`, sorted).
 *
 * The repository travels in the query string, out of the route policy's reach, so
 * the single repository this route touches is authorized here — and an invisible
 * one answers exactly like a missing one, so the difference cannot be used to
 * enumerate repositories that were never shared.
 */
export interface GitHubBranchesApiDependencies {
  getRepository(repositoryKey: string): GuardrailRepository | null;
  listBranchNames(repository: GuardrailRepository): Promise<string[]>;
}

const MAX_KEY = 512;

export function createGitHubBranchesApp(deps: GitHubBranchesApiDependencies): Hono {
  const api = new Hono();

  api.get("/github/branches", async (c) => {
    c.header("Cache-Control", "no-store");
    const repositoryKey = (c.req.query("repositoryKey") ?? "").trim();
    if (repositoryKey === "" || repositoryKey.length > MAX_KEY) {
      return c.json({ error: "repository_key_required" }, 400);
    }
    if (!canSeeRepository(principalOf(c), repositoryKey)) return c.json({ error: "not_found" }, 404);
    const repository = deps.getRepository(repositoryKey);
    if (repository === null) return c.json({ error: "not_found" }, 404);
    // A local checkout has no App authority to read branches with, and automation
    // does not cover it: say so instead of failing as if GitHub had refused.
    if (repository.source !== "github" || repository.repositoryPath !== null
      || repository.githubConnectionId === null
      || repository.githubInstallationId === null
      || repository.githubRepositoryId === null) {
      return c.json({ error: "github_repository_unsupported" }, 409);
    }
    try {
      return c.json({ branches: [...await deps.listBranchNames(repository)].sort() });
    } catch {
      // Whatever GitHub or the vault said stays out of the response: an upstream
      // message can carry an installation id or a token fragment.
      return c.json({ error: "github_branches_failed" }, 502);
    }
  });

  return api;
}
