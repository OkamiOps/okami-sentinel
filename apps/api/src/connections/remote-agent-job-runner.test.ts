import assert from "node:assert/strict";
import test from "node:test";

import type { StoredProviderConnection } from "../connections-store.js";
import { VaultError, type ConnectionSecretBundle, type CredentialVault } from "../credentials/credential-vault.js";
import {
  RemoteAgentJobError,
  createRemoteAgentJobRunner,
  type CursorBackgroundAgentsClient,
} from "./remote-agent-job-runner.js";

test("Cursor Background refuses an unconfirmed repository before reading the vault or calling the API", async () => {
  const vault = fakeVault({ apiKey: "cursor-secret" });
  const api = fakeCursorApi();
  const runner = createRemoteAgentJobRunner({
    vault,
    connections: fakeConnections(),
    models: fakeModels(),
    api,
  });

  await assert.rejects(
    runner.create({
      connectionId: "cursor-bg",
      repositoryUrl: "https://github.com/acme/repository",
      branch: "main",
      confirmed: false,
      instructions: "Review the repository.",
      modelId: "account-visible",
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof RemoteAgentJobError &&
      error.code === "remote_repository_confirmation_required",
  );

  assert.deepEqual(vault.getCalls, []);
  assert.deepEqual(api.calls, []);
});

test("Cursor Background reads the API key only in the creation request scope and never returns it", async () => {
  const vault = fakeVault({ apiKey: "cursor-secret" });
  const api = fakeCursorApi();
  const dependencies = {
    vault,
    connections: fakeConnections(),
    models: fakeModels(),
    api,
  };
  const runner = createRemoteAgentJobRunner(dependencies);

  const input = {
    connectionId: "cursor-bg",
    repositoryUrl: "https://github.com/acme/repository",
    branch: "review-branch",
    confirmed: true,
    instructions: "Review the repository.",
    modelId: "account-visible",
    signal: new AbortController().signal,
  };
  const job = await runner.create(input);

  assert.deepEqual(vault.getCalls, ["connection/cursor-bg"]);
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0]?.apiKey, "cursor-secret");
  assert.equal(api.safeCalls[0]?.modelId, "account-visible");
  assert.equal(job.status, "queued");
  assert.equal(JSON.stringify(job).includes("cursor-secret"), false);
  assert.equal(JSON.stringify(api.safeCalls).includes("cursor-secret"), false);
});

test("Cursor Background requires a model owned by the selected connection before reading the vault", async () => {
  const vault = fakeVault({ apiKey: "cursor-secret" });
  const api = fakeCursorApi();
  const dependencies = {
    vault,
    connections: fakeConnections(),
    api,
    models: fakeModels(),
  };
  const runner = createRemoteAgentJobRunner(dependencies);

  await assert.rejects(
    runner.create({
      connectionId: "cursor-bg",
      repositoryUrl: "https://github.com/acme/repository",
      branch: "review-branch",
      confirmed: true,
      instructions: "Review the repository.",
      modelId: "not-in-catalog",
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof RemoteAgentJobError && error.code === "remote_model_not_found",
  );

  assert.deepEqual(vault.getCalls, []);
  assert.deepEqual(api.calls, []);
});

test("Cursor Background polls only until its v1 run reaches a terminal state", async () => {
  const vault = fakeVault({ apiKey: "cursor-secret" });
  const api = fakeCursorApi();
  const sleeps: number[] = [];
  const states = [
    { status: "queued" as const, terminal: false },
    { status: "running" as const, terminal: false },
    { status: "completed" as const, terminal: true },
  ];
  api.status = async () => {
    api.statusCalls += 1;
    return states.shift()!;
  };
  const runner = createRemoteAgentJobRunner({
    vault,
    connections: fakeConnections(),
    models: fakeModels(),
    api,
    sleep: async (delay) => {
      sleeps.push(delay);
    },
  });
  const created = await runner.create({
    connectionId: "cursor-bg",
    repositoryUrl: "https://github.com/acme/repository",
    branch: "main",
    confirmed: true,
    instructions: "Review the repository.",
    modelId: "account-visible",
    signal: new AbortController().signal,
  });

  const status = await runner.waitForTerminal(created.remoteJobId, {
    signal: new AbortController().signal,
    deadlineMs: 10_000,
    pollIntervalMs: 250,
  });

  assert.deepEqual(status, { status: "completed", terminal: true });
  assert.deepEqual(sleeps, [250, 250]);
  assert.equal(api.statusCalls, 3);
});

test("Cursor Background cancels the remote v1 run when polling is aborted or reaches its deadline", async () => {
  const vault = fakeVault({ apiKey: "cursor-secret" });
  const api = fakeCursorApi();
  api.status = async () => ({ status: "running", terminal: false });
  let now = 0;
  const runner = createRemoteAgentJobRunner({
    vault,
    connections: fakeConnections(),
    models: fakeModels(),
    api,
    now: () => now,
    sleep: async () => {
      now = 1_000;
    },
  });
  const created = await runner.create({
    connectionId: "cursor-bg",
    repositoryUrl: "https://github.com/acme/repository",
    branch: "main",
    confirmed: true,
    instructions: "Review the repository.",
    modelId: "account-visible",
    signal: new AbortController().signal,
  });

  await assert.rejects(
    runner.waitForTerminal(created.remoteJobId, {
      signal: new AbortController().signal,
      deadlineMs: 500,
      pollIntervalMs: 250,
    }),
    (error: unknown) => error instanceof RemoteAgentJobError &&
      error.code === "remote_job_deadline_exceeded",
  );

  await waitFor(() => api.cancelCalls === 1, 50);
  assert.equal(api.cancelCalls, 1);
  assert.equal(JSON.stringify(api.safeCalls).includes("cursor-secret"), false);
});

test("Cursor Background does not call the remote API after the stored API key has been deleted", async () => {
  const vault = fakeVault({ apiKey: "cursor-secret" });
  const api = fakeCursorApi();
  const runner = createRemoteAgentJobRunner({
    vault,
    connections: fakeConnections(),
    models: fakeModels(),
    api,
  });
  const created = await runner.create({
    connectionId: "cursor-bg",
    repositoryUrl: "https://github.com/acme/repository",
    branch: "main",
    confirmed: true,
    instructions: "Review the repository.",
    modelId: "account-visible",
    signal: new AbortController().signal,
  });
  vault.get = async () => {
    throw new VaultError("credential_not_found");
  };

  await assert.rejects(
    runner.status(created.remoteJobId),
    (error: unknown) => error instanceof RemoteAgentJobError && error.code === "credential_rejected",
  );

  assert.equal(api.statusCalls, 0);
});

test("Cursor Background sends a remote cancellation when an active polling signal is aborted", async () => {
  const vault = fakeVault({ apiKey: "cursor-secret" });
  const api = fakeCursorApi();
  const runner = createRemoteAgentJobRunner({
    vault,
    connections: fakeConnections(),
    models: fakeModels(),
    api,
  });
  const created = await runner.create({
    connectionId: "cursor-bg",
    repositoryUrl: "https://github.com/acme/repository",
    branch: "main",
    confirmed: true,
    instructions: "Review the repository.",
    modelId: "account-visible",
    signal: new AbortController().signal,
  });
  const abort = new AbortController();
  abort.abort();

  await assert.rejects(
    runner.waitForTerminal(created.remoteJobId, {
      signal: abort.signal,
      deadlineMs: 1_000,
      pollIntervalMs: 250,
    }),
    (error: unknown) => error instanceof RemoteAgentJobError && error.code === "remote_job_cancelled",
  );

  assert.equal(api.statusCalls, 0);
  await waitFor(() => api.cancelCalls === 1, 50);
  assert.equal(api.cancelCalls, 1);
});

test("Cursor Background bounds an ignored status and ignored cancellation after its polling deadline", async () => {
  const vault = fakeVault({ apiKey: "cursor-secret" });
  const api = fakeCursorApi();
  let statusSignal: AbortSignal | undefined;
  let cancelSignal: AbortSignal | undefined;
  api.status = async (input) => {
    statusSignal = input.signal;
    return new Promise(() => {});
  };
  api.cancel = async (input) => {
    cancelSignal = input.signal;
    api.cancelCalls += 1;
    return new Promise(() => {});
  };
  const dependencies = {
    vault,
    connections: fakeConnections(),
    models: fakeModels(),
    api,
    requestTimeoutMs: 20,
  };
  const runner = createRemoteAgentJobRunner(dependencies);
  const created = await runner.create({
    connectionId: "cursor-bg",
    repositoryUrl: "https://github.com/acme/repository",
    branch: "main",
    confirmed: true,
    instructions: "Review the repository.",
    modelId: "account-visible",
    signal: new AbortController().signal,
  });

  const outcome = await settleWithin(
    runner.waitForTerminal(created.remoteJobId, {
      signal: new AbortController().signal,
      deadlineMs: 5,
      pollIntervalMs: 1,
    }),
    100,
  );

  assert.equal(outcome, "remote_job_deadline_exceeded");
  assert.equal(statusSignal instanceof AbortSignal, true);
  assert.equal(cancelSignal instanceof AbortSignal, true);
  assert.equal(api.cancelCalls, 1);
});

test("Cursor Background returns its deadline without awaiting an ignored cleanup cancel", async () => {
  const vault = fakeVault({ apiKey: "cursor-secret" });
  const api = fakeCursorApi();
  api.status = async () => {
    api.statusCalls += 1;
    return new Promise(() => {});
  };
  api.cancel = async () => {
    api.cancelCalls += 1;
    return new Promise(() => {});
  };
  const runner = createRemoteAgentJobRunner({
    vault,
    connections: fakeConnections(),
    models: fakeModels(),
    api,
  });
  const created = await runner.create({
    connectionId: "cursor-bg",
    repositoryUrl: "https://github.com/acme/repository",
    branch: "main",
    confirmed: true,
    instructions: "Review the repository.",
    modelId: "account-visible",
    signal: new AbortController().signal,
  });

  const outcome = await settleWithin(
    runner.waitForTerminal(created.remoteJobId, {
      signal: new AbortController().signal,
      deadlineMs: 5,
      pollIntervalMs: 1,
    }),
    100,
  );

  assert.equal(outcome, "remote_job_deadline_exceeded");
  await waitFor(() => api.cancelCalls === 1, 50);
  assert.equal(api.cancelCalls, 1);
});

test("Cursor Background skips 409 reconciliation when terminal cleanup has no remaining budget", async () => {
  const vault = fakeVault({ apiKey: "cursor-secret" });
  const api = fakeCursorApi();
  api.status = async () => {
    api.statusCalls += 1;
    return new Promise(() => {});
  };
  api.cancel = async () => {
    api.cancelCalls += 1;
    throw { code: "run_not_cancellable" };
  };
  const runner = createRemoteAgentJobRunner({
    vault,
    connections: fakeConnections(),
    models: fakeModels(),
    api,
  });
  const created = await runner.create({
    connectionId: "cursor-bg",
    repositoryUrl: "https://github.com/acme/repository",
    branch: "main",
    confirmed: true,
    instructions: "Review the repository.",
    modelId: "account-visible",
    signal: new AbortController().signal,
  });

  const outcome = await settleWithin(
    runner.waitForTerminal(created.remoteJobId, {
      signal: new AbortController().signal,
      deadlineMs: 5,
      pollIntervalMs: 1,
    }),
    100,
  );

  assert.equal(outcome, "remote_job_deadline_exceeded");
  await waitFor(() => api.cancelCalls === 1, 50);
  assert.equal(api.statusCalls, 1);
});

test("Cursor Background reconciles a 409 cancel race through the final run state", async () => {
  const vault = fakeVault({ apiKey: "cursor-secret" });
  const api = fakeCursorApi();
  api.cancel = async () => {
    api.cancelCalls += 1;
    throw { code: "run_not_cancellable" };
  };
  api.status = async () => {
    api.statusCalls += 1;
    return { status: "completed", terminal: true };
  };
  const dependencies = {
    vault,
    connections: fakeConnections(),
    api,
    models: fakeModels(),
  };
  const runner = createRemoteAgentJobRunner(dependencies);
  const created = await runner.create({
    connectionId: "cursor-bg",
    repositoryUrl: "https://github.com/acme/repository",
    branch: "main",
    confirmed: true,
    instructions: "Review the repository.",
    modelId: "account-visible",
    signal: new AbortController().signal,
  });

  const result = await runner.cancel(created.remoteJobId);

  assert.deepEqual(result, { remote: false });
  assert.equal(api.statusCalls, 1);
  assert.equal(api.cancelCalls, 1);
});

test("Cursor Background rejects remote identifiers that could expose an upstream URL", async () => {
  const vault = fakeVault({ apiKey: "cursor-secret" });
  const api = fakeCursorApi();
  api.create = async () => ({
    agentId: "https://api.cursor.com/v1/agents/private",
    runId: "run-1",
    status: "queued",
  });
  const runner = createRemoteAgentJobRunner({
    vault,
    connections: fakeConnections(),
    models: fakeModels(),
    api,
  });

  await assert.rejects(
    runner.create({
      connectionId: "cursor-bg",
      repositoryUrl: "https://github.com/acme/repository",
      branch: "main",
      confirmed: true,
      instructions: "Review the repository.",
      modelId: "account-visible",
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof RemoteAgentJobError && error.code === "protocol_unsupported",
  );
});

function fakeConnections(): { get(id: string): StoredProviderConnection | null } {
  const cursor = connection();
  return {
    get(id) {
      return id === cursor.id ? cursor : null;
    },
  };
}

function connection(): StoredProviderConnection {
  return {
    id: "cursor-bg",
    scopeId: "local",
    name: "Cursor Background",
    providerKind: "cursor",
    routeKind: "cursor-background-agents",
    transport: "remote-agent-api",
    authKind: "api-key",
    protocol: "cursor-background-agents",
    status: "ready",
    modelSelectionMode: "catalog",
    defaultModelId: null,
    lastTestedAt: null,
    lastModelSyncAt: null,
    modelCatalogStale: false,
    display: {
      providerLabel: "Cursor",
      routeLabel: "Background Agents",
      secretConfigured: true,
      endpointConfigured: true,
      endpointKind: "preset",
    },
    credentialRef: "connection/cursor-bg",
  };
}

function fakeVault(bundle: ConnectionSecretBundle): CredentialVault & { getCalls: string[] } {
  const getCalls: string[] = [];
  return {
    getCalls,
    async available() {
      return { available: true, backend: "keychain" } as const;
    },
    async put() {},
    async get(ref) {
      getCalls.push(ref);
      return bundle;
    },
    async delete() {},
  };
}

function fakeCursorApi(): CursorBackgroundAgentsClient & {
  calls: Array<{ apiKey: string }>;
  safeCalls: Array<Record<string, unknown>>;
  statusCalls: number;
  cancelCalls: number;
} {
  const calls: Array<{ apiKey: string }> = [];
  const safeCalls: Array<Record<string, unknown>> = [];
  const api: CursorBackgroundAgentsClient & {
    calls: Array<{ apiKey: string }>;
    safeCalls: Array<Record<string, unknown>>;
    statusCalls: number;
    cancelCalls: number;
  } = {
    calls,
    safeCalls,
    statusCalls: 0,
    cancelCalls: 0,
    async create(input) {
      calls.push({ apiKey: input.apiKey });
      safeCalls.push({
        repositoryUrlConfigured: input.repositoryUrl.length > 0,
        branchConfigured: input.branch.length > 0,
        modelId: (input as { modelId?: unknown }).modelId,
      });
      return { agentId: "bc-agent-1", runId: "run-1", status: "queued" };
    },
    async status() {
      api.statusCalls += 1;
      return { status: "queued", terminal: false };
    },
    async cancel() {
      api.cancelCalls += 1;
    },
  };
  return api;
}

function fakeModels(): {
  getModel(connectionId: string, modelId: string): { connectionId: string; id: string } | null;
} {
  return {
    getModel(connectionId, modelId) {
      return connectionId === "cursor-bg" && modelId === "account-visible"
        ? { connectionId, id: modelId }
        : null;
    },
  };
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<string> {
  return Promise.race([
    promise.then(
      () => "resolved",
      (error: unknown) => error instanceof RemoteAgentJobError ? error.code : "rejected",
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve("test_timeout"), timeoutMs)),
  ]);
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for asynchronous cleanup");
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}
