/** Mocked browser-regression port. Five self-hosted runners share one host, so CI publishes a free port instead of always binding 4175. */
export const E2E_WEB_PORT_ENV = "CSB_WEB_E2E_PORT";
const LEGACY_E2E_WEB_PORT_ENV = "CSB_E2E_WEB_PORT";
export const DEFAULT_E2E_WEB_PORT = 4175;

export function e2eWebPort(env: NodeJS.ProcessEnv = process.env): number {
  const selected = selectedPort(env);
  const webPort = Number(selected?.value ?? DEFAULT_E2E_WEB_PORT);
  if (!Number.isSafeInteger(webPort) || webPort < 1 || webPort > 65_535) {
    throw new Error(`${selected?.name ?? E2E_WEB_PORT_ENV} must be a valid local port`);
  }
  return webPort;
}

export function e2eWebOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return `http://127.0.0.1:${e2eWebPort(env)}`;
}

/** Command, readiness URL, and baseURL for the mocked Vite preview. CI keeps strictPort and never reuses a server another job already holds. */
export function e2ePreviewServer(env: NodeJS.ProcessEnv = process.env): {
  command: string;
  url: string;
  baseURL: string;
  reuseExistingServer: false;
} {
  const webPort = e2eWebPort(env);
  const baseURL = `http://127.0.0.1:${webPort}`;
  return {
    command: `pnpm exec vite preview --host 127.0.0.1 --port ${webPort} --strictPort`,
    url: baseURL,
    baseURL,
    reuseExistingServer: false,
  };
}

function selectedPort(env: NodeJS.ProcessEnv): { name: string; value: string } | null {
  for (const name of [E2E_WEB_PORT_ENV, LEGACY_E2E_WEB_PORT_ENV]) {
    const value = env[name];
    if (value !== undefined && value !== "") return { name, value };
  }
  return null;
}
