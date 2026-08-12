import { Hono, type Context } from "hono";

import { GITHUB_APP_CALLBACK_URL, GITHUB_APP_LOCAL_ORIGIN } from "./config.js";
import { SystemGitHubAppCredentialStore } from "./credentials/system-github-app-credential-store.js";
import type {
  GitHubAppConnectionMetadata,
  GitHubAppInstallationMetadata,
  GitHubInstallationRepositoryMetadata,
} from "./gate-store.js";
import { GitHubAppClient } from "./github-app/github-app-client.js";
import {
  GitHubAppService,
  githubAppServiceErrorCode,
  type CompleteManifestCallbackInput,
} from "./github-app/github-app-service.js";
import { GitHubAppStore } from "./github-app/github-app-store.js";
import { GitHubAppManifestFlow, type PublicManifestFlowState } from "./github-app/manifest-flow.js";
import { globalSecretRedactor } from "./redaction.js";

export interface GitHubAppApiService {
  startManifest(): { flowId: string; authorizeUrl: string };
  manifestAuthorization(flowId: string): ReturnType<GitHubAppManifestFlow["authorization"]>;
  manifestState(flowId: string): PublicManifestFlowState;
  completeManifestCallback(input: CompleteManifestCallbackInput): Promise<PublicManifestFlowState>;
  listConnections(): GitHubAppConnectionMetadata[];
  refreshInstallations(connectionId: string): Promise<GitHubAppInstallationMetadata[]>;
  refreshRepositories(installationId: string): Promise<GitHubInstallationRepositoryMetadata[]>;
  disconnect(connectionId: string): Promise<void>;
}

let systemService: GitHubAppService | undefined;

export function createGitHubAppApi(injectedService?: GitHubAppApiService): Hono {
  const api = new Hono();
  const service = (): GitHubAppApiService => injectedService ?? getSystemGitHubAppService();

  api.post("/guardrails/github-app/manifest/start", (c) => {
    try {
      return c.json(service().startManifest(), 201);
    } catch (error) {
      return githubAppError(c, error);
    }
  });

  api.get("/guardrails/github-app/manifest/authorize/:flowId", (c) => {
    try {
      const authorization = service().manifestAuthorization(c.req.param("flowId"));
      c.header(
        "Content-Security-Policy",
        "default-src 'none'; form-action https://github.com; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      );
      c.header("Cache-Control", "no-store");
      c.header("Referrer-Policy", "no-referrer");
      return c.html(manifestBridgeHtml(authorization.actionUrl, authorization.manifest));
    } catch (error) {
      return githubAppError(c, error);
    }
  });

  api.get("/guardrails/github-app/manifest/flows/:flowId", (c) => {
    try {
      return c.json({ flow: service().manifestState(c.req.param("flowId")) });
    } catch (error) {
      return githubAppError(c, error);
    }
  });

  api.get("/guardrails/github-app/manifest/callback", async (c) => {
    const flowId = c.req.query("flowId");
    const state = c.req.query("state");
    const code = c.req.query("code") ?? null;
    const errorQuery = c.req.query("error") ?? null;
    if (!flowId || !state) {
      return callbackHtml(c, "Falha ao validar o retorno do GitHub.", 400);
    }
    try {
      const result = await service().completeManifestCallback({
        flowId,
        state,
        code,
        error: errorQuery,
      });
      const connection = result.status === "completed"
        ? service().listConnections().find((item) => item.id === result.connectionId) ?? null
        : null;
      return callbackHtml(
        c,
        result.status === "denied"
          ? "Conexão cancelada. Você pode fechar esta janela."
          : connection
            ? "GitHub App criada. Agora instale-a na sua conta ou organização para liberar os repositórios."
            : "Conexão concluída. Retorne ao Sentinel e feche esta janela.",
        200,
        connection ? {
          href: githubAppInstallationUrl(connection.appSlug),
          label: "Instalar no GitHub",
        } : undefined,
      );
    } catch (error) {
      const codeValue = githubAppServiceErrorCode(error);
      return callbackHtml(c, `Falha no fluxo GitHub App: ${codeValue}`, githubStatus(codeValue));
    }
  });

  api.get("/guardrails/github-app/connections", (c) => {
    try {
      return c.json({
        connections: service().listConnections().map((connection) => ({
          ...connection,
          installationUrl: githubAppInstallationUrl(connection.appSlug),
        })),
      });
    } catch (error) {
      return githubAppError(c, error);
    }
  });

  api.delete("/guardrails/github-app/connections/:connectionId", async (c) => {
    try {
      await service().disconnect(c.req.param("connectionId"));
      return c.json({ ok: true });
    } catch (error) {
      return githubAppError(c, error);
    }
  });

  api.get("/guardrails/github-app/connections/:connectionId/installations", async (c) => {
    try {
      return c.json({
        installations: await service().refreshInstallations(c.req.param("connectionId")),
      });
    } catch (error) {
      return githubAppError(c, error);
    }
  });

  api.get("/guardrails/github-app/installations/:installationId/repositories", async (c) => {
    try {
      return c.json({
        repositories: await service().refreshRepositories(c.req.param("installationId")),
      });
    } catch (error) {
      return githubAppError(c, error);
    }
  });

  return api;
}

export function getSystemGitHubAppService(): GitHubAppService {
  if (systemService) return systemService;
  const credentials = new SystemGitHubAppCredentialStore({
    redactor: globalSecretRedactor,
  });
  const client = new GitHubAppClient({
    credentials,
    redactor: globalSecretRedactor,
  });
  systemService = new GitHubAppService({
    flow: new GitHubAppManifestFlow({
      callbackUrl: GITHUB_APP_CALLBACK_URL,
      localOrigin: GITHUB_APP_LOCAL_ORIGIN,
    }),
    credentials,
    client,
    store: new GitHubAppStore(),
  });
  return systemService;
}

function githubAppError(c: Context, error: unknown) {
  const code = githubAppServiceErrorCode(error);
  return c.json({ error: code }, githubStatus(code));
}

function githubStatus(code: string): 400 | 401 | 404 | 409 | 502 {
  if (code.endsWith("_not_found")) return 404;
  if (code === "github_credential_rejected") return 401;
  if (
    code.includes("revoked") ||
    code === "manifest_flow_expired" ||
    code === "manifest_state_invalid" ||
    code === "github_credential_cleanup_failed"
  ) return 409;
  if (code === "github_request_rejected") return 400;
  return 502;
}

function manifestBridgeHtml(actionUrl: string, manifest: unknown): string {
  return `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GitHub App · Sentinel</title></head>
<body style="margin:0;background:#07080d;color:#f6f5f2;font:16px ui-monospace,monospace;display:grid;min-height:100vh;place-items:center">
  <form id="manifest" action="${escapeAttribute(actionUrl)}" method="post" style="display:grid;gap:16px;max-width:560px;padding:32px;border:1px solid #ff6b1a">
    <input type="hidden" name="manifest" value="${escapeAttribute(JSON.stringify(manifest))}">
    <strong>ABRINDO O REGISTRO SEGURO NO GITHUB…</strong>
    <span>Se o redirecionamento não iniciar, use o botão abaixo.</span>
    <button type="submit" style="padding:12px 16px;background:#ff6b1a;border:0;font:inherit;font-weight:700">Continuar no GitHub</button>
  </form>
  <script>document.getElementById('manifest').submit()</script>
</body></html>`;
}

function callbackHtml(
  c: Context,
  message: string,
  status: 200 | 400 | 401 | 404 | 409 | 502,
  action?: { href: string; label: string },
) {
  c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  const actionHtml = action
    ? `<a href="${escapeAttribute(action.href)}" rel="noreferrer" style="display:inline-flex;margin-top:24px;padding:12px 16px;background:#ff6b1a;color:#07080d;text-decoration:none;font-weight:800">${escapeText(action.label)}</a>`
    : "";
  return c.html(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GitHub App · Sentinel</title></head><body style="margin:0;background:#07080d;color:#f6f5f2;font:16px ui-monospace,monospace;display:grid;min-height:100vh;place-items:center"><main style="max-width:640px;padding:32px;border:1px solid #ff6b1a"><strong style="display:block;line-height:1.6">${escapeText(message)}</strong>${actionHtml}</main></body></html>`, status);
}

function githubAppInstallationUrl(appSlug: string): string {
  return `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`;
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
