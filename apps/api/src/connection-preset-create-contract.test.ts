import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";
import {
  VISIBLE_CONNECTION_PRESET_COUNT,
  VISIBLE_CONNECTION_PRESET_IDS,
  VISIBLE_CONNECTION_PRESETS,
  type ConnectionAuthKind,
  type ConnectionPreset,
  type ConnectionSecretInput,
  type ConnectionTransport,
  type CreateProviderConnectionRequest,
  type ModelSelectionMode,
  type ProviderProtocol,
} from "@csb/shared";
import { ConnectionStore } from "./connections-store.js";
import {
  ConnectionServiceError,
  createConnectionsService,
} from "./connections-service.js";
import { createRouteRegistry } from "./connections/route-registry.js";
import type { XaiOAuthRouteAdapter } from "./connections/xai-oauth-adapter.js";
import type {
  ConnectionSecretBundle,
  CredentialVault,
} from "./credentials/credential-vault.js";
import { VaultError } from "./credentials/credential-vault.js";

class MatrixVault implements CredentialVault {
  readonly values = new Map<string, ConnectionSecretBundle>();

  async available() {
    return { available: true, backend: "keychain" as const };
  }

  async put(ref: string, value: ConnectionSecretBundle) {
    this.values.set(ref, structuredClone(value));
  }

  async get(ref: string) {
    const value = this.values.get(ref);
    if (value === undefined) throw new VaultError("credential_not_found");
    return structuredClone(value);
  }

  async delete(ref: string) {
    this.values.delete(ref);
  }
}

const EXPECTED_VISIBLE_PRESET_IDS = [
  "openai-local-codex",
  "openai-chatgpt-browser-oauth",
  "openai-chatgpt-device-code",
  "openai-api",
  "xai-grok-local",
  "xai-direct-device-oauth",
  "xai-api",
  "claude-code-local",
  "anthropic-api",
  "cursor-local",
  "cursor-cloud-api",
  "openrouter-api",
  "gemini-api",
  "deepseek-api",
  "minimax-token-plan",
  "mimo-token-plan",
  "custom-openai-compatible",
  "custom-anthropic-compatible",
] as const;

test("every visible connection preset creates and cleans up through the local service boundary", async () => {
  assert.equal(VISIBLE_CONNECTION_PRESET_COUNT, 18);
  assert.deepEqual(VISIBLE_CONNECTION_PRESET_IDS, EXPECTED_VISIBLE_PRESET_IDS);
  assert.deepEqual(
    VISIBLE_CONNECTION_PRESETS.map((preset) => preset.id),
    EXPECTED_VISIBLE_PRESET_IDS,
  );

  const db = new Database(":memory:");
  const vault = new MatrixVault();
  const store = new ConnectionStore(db);
  const routes = createRouteRegistry({ vault, xaiOAuth: xaiOAuthRouteAdapter() });
  const service = createConnectionsService({ vault, store, routes });

  try {
    for (const preset of VISIBLE_CONNECTION_PRESETS) {
      if (preset.availability !== "available") {
        assert.ok(
          preset.availability === "unavailable" || preset.availability === "disabled",
          `${preset.id} must be explicitly unavailable or disabled`,
        );
        continue;
      }

      const manifest = routes.getManifest(preset.routeKind);
      assert.deepEqual(
        manifest && {
          providerKind: manifest.providerKind,
          transport: manifest.transport,
          protocol: manifest.protocol,
        },
        {
          providerKind: preset.providerKind,
          transport: preset.transport,
          protocol: preset.protocol,
        },
        `${preset.id} must agree with its registered route manifest`,
      );
      assert.ok(
        manifest?.authKinds.includes(preset.authKind),
        `${preset.id} must use an auth kind accepted by its registered route manifest`,
      );
      assert.notEqual(routes.get(preset.routeKind), undefined, `${preset.id} must register an adapter`);

      const payload = await frontendCreatePayload(preset);
      const syntheticSecret = payload.secret;
      const connection = await createVisiblePreset(service, preset.id, payload);
      const stored = store.get(connection.id);

      assert.deepEqual(
        pickRouteFields(connection),
        pickRouteFields(payload),
        `${preset.id} must persist the frontend payload unchanged`,
      );
      assert.equal(stored?.credentialRef !== null, syntheticSecret !== undefined);
      assert.doesNotMatch(JSON.stringify({ connection, stored }), /matrix-secret-/);
      assert.deepEqual(
        [...vault.values.entries()],
        syntheticSecret === undefined ? [] : [[stored!.credentialRef!, syntheticSecret]],
      );

      assert.equal(await service.remove(connection.id), true);
      assert.equal(store.get(connection.id), null);
      assert.deepEqual([...vault.values.entries()], []);
    }
  } finally {
    for (const connection of store.list()) await service.remove(connection.id);
    assert.deepEqual([...vault.values.entries()], []);
    db.close();
  }
});

interface FrontendConnectionDraft {
  name: string;
  providerKind: string;
  routeKind: string;
  transport: ConnectionTransport;
  authKind: ConnectionAuthKind;
  protocol: ProviderProtocol;
  modelSelectionMode: ModelSelectionMode;
  apiKey: string;
  baseUrl: string;
  discoveryUrl: string;
  headers: string;
}

interface FrontendConnectionModule {
  blankConnectionDraft(): FrontendConnectionDraft;
  createConnectionRequest(draft: FrontendConnectionDraft): CreateProviderConnectionRequest;
}

interface FrontendPresetModule {
  applyConnectionPreset(
    draft: FrontendConnectionDraft,
    presetId: string,
    nameSuggestion?: string,
  ): FrontendConnectionDraft;
}

async function frontendCreatePayload(preset: ConnectionPreset): Promise<CreateProviderConnectionRequest> {
  const [connections, presets] = await Promise.all([
    import(new URL("../../web/src/lib/connections.ts", import.meta.url).href) as Promise<FrontendConnectionModule>,
    import(new URL("../../web/src/lib/connection-presets.ts", import.meta.url).href) as Promise<FrontendPresetModule>,
  ]);
  const draft = presets.applyConnectionPreset(
    connections.blankConnectionDraft(),
    preset.id,
    visiblePresetName(preset.id),
  );
  const secret = syntheticSecretFor(preset);
  draft.apiKey = secret?.apiKey ?? "";
  draft.baseUrl = secret?.baseUrl ?? draft.baseUrl;
  draft.discoveryUrl = secret?.discoveryUrl ?? "";
  draft.headers = Object.entries(secret?.headers ?? {})
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
  return connections.createConnectionRequest(draft);
}

function syntheticSecretFor(preset: ConnectionPreset): ConnectionSecretInput | undefined {
  if (preset.credentialMode === "none" || preset.credentialMode === "managed-oauth") {
    return undefined;
  }
  const apiKey = `matrix-secret-${preset.id}`;
  if (preset.endpointMode === "custom") {
    return {
      apiKey,
      baseUrl: `https://${preset.id}.matrix.invalid/v1`,
      headers: { "X-Matrix-Secret": apiKey },
    };
  }
  return {
    apiKey,
    ...(preset.endpointMode === "mimo-region"
      ? { baseUrl: "https://token-plan-cn.xiaomimimo.com/v1" }
      : {}),
  };
}

/** Keep names human-readable and intentionally free of credential-shaped xai-* tokens. */
function visiblePresetName(id: string): string {
  const names: Record<string, string> = {
    "xai-grok-local": "xAI Grok local",
    "xai-direct-device-oauth": "xAI login pelo dispositivo",
    "xai-api": "xAI API",
  };
  return names[id] ?? `Matrix ${id.replaceAll("-", " ")}`;
}

async function createVisiblePreset(
  service: ReturnType<typeof createConnectionsService>,
  presetId: string,
  payload: CreateProviderConnectionRequest,
) {
  try {
    return await service.create(payload);
  } catch (error) {
    if (error instanceof ConnectionServiceError && error.code === "invalid_connection") {
      assert.fail(`${presetId} is visible and available but its frontend payload returned invalid_connection`);
    }
    throw error;
  }
}

function pickRouteFields(
  connection: Pick<
    CreateProviderConnectionRequest,
    "providerKind" | "routeKind" | "transport" | "authKind" | "protocol" | "modelSelectionMode"
  >,
) {
  return {
    providerKind: connection.providerKind,
    routeKind: connection.routeKind,
    transport: connection.transport,
    authKind: connection.authKind,
    protocol: connection.protocol,
    modelSelectionMode: connection.modelSelectionMode,
  };
}

function xaiOAuthRouteAdapter(): XaiOAuthRouteAdapter {
  return {
    routeKind: "xai-oauth",
    transport: "http-inference",
    protocol: "xai-oauth-responses",
    inspect: async () => ({ available: true, reason: null, supportsRuntimeDefault: false }),
    startAuth: async () => ({
      flowId: "matrix-xai-flow",
      status: "pending",
      authUrl: null,
      verificationUrl: "https://auth.x.ai/verify",
      userCode: "MATRIX",
      expiresAt: null,
    }),
    getAuth: async () => null,
    cancelAuth: async () => {},
    disconnectAuth: async () => ({ status: "local_removed" }),
    discoverModels: async () => ({ models: [], supportsRuntimeDefault: false }),
    probe: async (connection, selection) => ({
      id: "matrix-xai-probe",
      connectionId: connection.id,
      modelId: selection.modelId,
      protocol: connection.protocol,
      status: "failed",
      capabilities: {
        tools: "unknown",
        artifactOutput: "unknown",
        structuredOutput: "unknown",
        boundedExecution: "unknown",
        osIsolation: "unknown",
        streaming: "unknown",
        usage: "unknown",
        cancellation: "unknown",
      },
      errorCode: "protocol_unsupported",
      checkedAt: "2026-08-11T00:00:00.000Z",
    }),
  };
}
