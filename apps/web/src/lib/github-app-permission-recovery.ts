import type { GitHubAppConnection, GitHubAppInstallation } from "../api";

export interface GitHubPermissionRecovery {
  appSettingsUrl: string;
  installationSettingsUrl: string;
}

export function githubPermissionRecovery(
  connection: GitHubAppConnection,
  installation: GitHubAppInstallation,
): GitHubPermissionRecovery | null {
  if (installation.connectionId !== connection.id) return null;
  const appSlug = encodeURIComponent(connection.appSlug);
  const installationId = encodeURIComponent(installation.id);
  const installationSettingsUrl = installation.accountType === "Organization"
    ? `https://github.com/organizations/${encodeURIComponent(installation.accountLogin)}/settings/installations/${installationId}`
    : `https://github.com/settings/installations/${installationId}`;
  return {
    appSettingsUrl: `https://github.com/settings/apps/${appSlug}/permissions`,
    installationSettingsUrl,
  };
}
