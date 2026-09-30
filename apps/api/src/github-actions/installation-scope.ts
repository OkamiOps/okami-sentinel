/**
 * What the 15-minute reconciliation needs to know about the App's installations,
 * read one installation at a time.
 *
 * GitHub does not redeliver an `installation` or `installation_repositories`
 * webhook, so re-listing the installations is the only thing that ever notices a
 * repository taken out of an installation while we were not listening. That makes
 * this provider's failure mode the interesting part: a single shared `catch`
 * turned one revoked installation — a row `listInstallations` keeps for ever —
 * into "GitHub could not be asked", and the backstop then disabled nothing again
 * for any connection while reporting one error per cycle.
 *
 * So: connections that are not ready are not asked; an installation that is not
 * ready is not asked either, and its actions are disabled, which is exactly the
 * spec's `installation` `deleted`/`suspend` rule reaching us late; and a listing
 * that genuinely failed costs *that* installation, which is then simply absent
 * from the report — and absent means "not observed", which the reconciliation
 * leaves alone rather than disabling on a blink.
 */
export interface InstallationScopeReport {
  /** Installations that answered, with the repositories they still reach. */
  scopes: ReadonlyArray<{ installationId: string; repositoryIds: readonly string[] }>;
  /** Installations or connections this cycle could not read. Counted as errors. */
  failures: number;
}

export interface InstallationScopeDependencies {
  listConnections(): ReadonlyArray<{ id: string; status: string }>;
  listInstallations(connectionId: string): Promise<ReadonlyArray<{ id: string; status: string }>>;
  listRepositories(installationId: string): Promise<ReadonlyArray<{ repositoryId: string }>>;
  disableActionsForInstallation(installationId: string, reason: string): void;
}

export async function readGitHubInstallationScopes(
  deps: InstallationScopeDependencies,
): Promise<InstallationScopeReport> {
  const scopes: Array<{ installationId: string; repositoryIds: readonly string[] }> = [];
  let failures = 0;
  for (const connection of deps.listConnections()) {
    if (connection.status !== "ready") continue;
    let installations: ReadonlyArray<{ id: string; status: string }>;
    try {
      installations = await deps.listInstallations(connection.id);
    } catch {
      failures += 1;
      continue;
    }
    for (const installation of installations) {
      if (installation.status !== "ready") {
        // Suspended or revoked: it reaches nothing, and saying so is what the
        // lost `installation` delivery would have said.
        deps.disableActionsForInstallation(installation.id, "installation_unauthorized");
        continue;
      }
      try {
        const repositories = await deps.listRepositories(installation.id);
        scopes.push({
          installationId: installation.id,
          repositoryIds: repositories.map((repository) => repository.repositoryId),
        });
      } catch {
        failures += 1;
      }
    }
  }
  return { scopes, failures };
}
