import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderConnection } from "@csb/shared";

import {
  blankConnectionDraft,
  changeConnectionTransport,
  connectionSaveErrorKey,
  createConnectionRequest,
  selectConnection,
  updateConnectionRequest,
  validateConnectionDraft,
} from "./connections.js";

test("maps only safe connection write codes to actionable localized messages", () => {
  assert.equal(connectionSaveErrorKey(new Error("csrf_invalid")), "connections.saveError.sessionExpired");
  assert.equal(connectionSaveErrorKey(new Error("secure_storage_unavailable")), "connections.saveError.secureStorageUnavailable");
  assert.equal(connectionSaveErrorKey(new Error("credential_write_failed")), "connections.saveError.credentialWriteFailed");
  assert.equal(connectionSaveErrorKey(new Error("connection_write_failed")), "connections.saveError.credentialWriteFailed");
  assert.equal(connectionSaveErrorKey(new Error("connection_state_inconsistent")), "connections.saveError.stateInconsistent");
  assert.equal(connectionSaveErrorKey(new Error("invalid_connection")), "connections.saveError.invalidConnection");
  assert.equal(connectionSaveErrorKey(new Error("private upstream diagnostics")), "connections.saveError");
});

function connectionFixture(id: string, name = "Local Codex"): ProviderConnection {
  return {
    id,
    scopeId: "local",
    name,
    providerKind: "openai",
    routeKind: "codex-cli",
    transport: "local-cli",
    authKind: "existing-session",
    protocol: "codex-cli",
    status: "ready",
    modelSelectionMode: "runtime-default",
    defaultModelId: null,
    lastTestedAt: null,
    lastModelSyncAt: null,
    modelCatalogStale: false,
    display: {
      providerLabel: "OpenAI",
      routeLabel: "Codex CLI",
      secretConfigured: true,
      endpointConfigured: false,
      endpointKind: null,
    },
  };
}

test("selects a requested connection and falls back to the first signal", () => {
  const first = connectionFixture("one");
  const second = connectionFixture("two", "Token plan");

  assert.equal(selectConnection([first, second], "two"), second);
  assert.equal(selectConnection([first, second], "missing"), first);
  assert.equal(selectConnection([], null), null);
});

test("keeps every secret-like draft field blank when opening a connection editor", () => {
  const draft = blankConnectionDraft(connectionFixture("one"));

  assert.equal(draft.apiKey, "");
  assert.equal(draft.baseUrl, "");
  assert.equal(draft.discoveryUrl, "");
  assert.equal(draft.headers, "");
});

test("permits a local CLI route without a secret bundle", () => {
  const draft = blankConnectionDraft();
  draft.name = "Codex subscription";
  draft.providerKind = "openai";
  draft.routeKind = "codex-cli";
  draft.transport = "local-cli";
  draft.authKind = "existing-session";
  draft.protocol = "codex-cli";

  assert.equal(validateConnectionDraft(draft), null);
  assert.equal(createConnectionRequest(draft).secret, undefined);
});

test("serializes only values entered during this edit and never a blank secret bundle", () => {
  const draft = blankConnectionDraft();
  draft.name = "Custom inference";
  draft.providerKind = "custom";
  draft.routeKind = "openai-compatible";
  draft.transport = "http-inference";
  draft.authKind = "api-key";
  draft.protocol = "openai-chat";
  draft.apiKey = "entered-now";
  draft.baseUrl = "https://token-plan.example/v1";

  const request = createConnectionRequest(draft);
  assert.deepEqual(request.secret, {
    apiKey: "entered-now",
    baseUrl: "https://token-plan.example/v1",
  });
  assert.equal("credentialRef" in request, false);
});

test("rejects an HTTP inference route without a valid secret field", () => {
  const draft = blankConnectionDraft();
  draft.name = "Missing credentials";

  assert.equal(validateConnectionDraft(draft), "secret");
});

test("clears secret-like fields when changing an HTTP draft to local CLI", () => {
  const draft = blankConnectionDraft();
  draft.apiKey = "api-secret";
  draft.baseUrl = "https://secret.example/v1";
  draft.discoveryUrl = "https://secret.example/v1/models";
  draft.headers = "X-Secret: header-secret";

  const cli = changeConnectionTransport(draft, "local-cli");
  assert.equal(cli.apiKey, "");
  assert.equal(cli.baseUrl, "");
  assert.equal(cli.discoveryUrl, "");
  assert.equal(cli.headers, "");
  assert.equal(createConnectionRequest({ ...cli, name: "Local CLI" }).secret, undefined);
});

test("never sends a secret in a local CLI patch", () => {
  const draft = blankConnectionDraft(connectionFixture("one"));
  draft.apiKey = "must-not-cross-the-boundary";

  assert.deepEqual(updateConnectionRequest(draft), { name: "Local Codex" });
});
