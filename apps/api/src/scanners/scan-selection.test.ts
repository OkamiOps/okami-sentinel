import assert from "node:assert/strict";
import test from "node:test";

import type {
  ProviderModel,
  ScanConnectionSnapshot,
  StartScanRequest,
} from "@csb/shared";
import type {
  LaunchPlanResolver,
  ScanLaunchPlan,
} from "../connections/launch-plan.js";
import {
  ScanSelectionError,
  resolveBeforeLaunch,
  resolveScanLaunchSelection,
} from "./scan-selection.js";

const model: ProviderModel = {
  connectionId: "openai-session",
  id: "gpt-live",
  displayName: "GPT Live",
  contextWindow: 128_000,
  capabilities: {
    tools: "supported",
    artifactOutput: "supported",
    structuredOutput: "supported",
    boundedExecution: "supported",
    osIsolation: "supported",
    streaming: "supported",
    usage: "supported",
    cancellation: "supported",
  },
  pricing: null,
  discoveredAt: "2026-08-11T12:00:00.000Z",
  source: "provider-api",
};

function plan(
  patch: Partial<ScanLaunchPlan> = {},
): ScanLaunchPlan {
  const snapshot: ScanConnectionSnapshot = {
    scanId: "scan-123",
    connectionId: "openai-session",
    routeKind: "openai-chatgpt-app-server",
    modelSelectionMode: "catalog",
    modelId: "gpt-live",
    capabilityCheckId: null,
    capturedAt: "2026-08-11T12:00:00.000Z",
  };
  return {
    engine: "mantis",
    connectionId: "openai-session",
    providerKind: "openai",
    routeKind: "openai-chatgpt-app-server",
    runnerKind: "codex-app-server",
    protocol: "codex-app-server",
    model,
    capabilityCheckId: null,
    scannerAuthMode: "chatgpt",
    snapshot,
    ...patch,
  };
}

function resolver(returned: ScanLaunchPlan): {
  resolver: LaunchPlanResolver;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  return {
    resolver: {
      resolve(input) {
        calls.push(input);
        return returned;
      },
    },
    calls,
  };
}

test("connection launch binds the server plan once and ignores client model/auth/provider", () => {
  const fixture = resolver(plan());
  const request: StartScanRequest = {
    repositoryPath: "/repo",
    engine: "mantis",
    provider: "attacker-provider",
    model: "attacker-model",
    authMode: "api-key",
    connection: {
      connectionId: "openai-session",
      modelSelectionMode: "catalog",
      modelId: "gpt-live",
    },
  };

  const selected = resolveScanLaunchSelection({
    request,
    scanId: "scan-123",
    launchPlans: fixture.resolver,
  });

  assert.deepEqual(fixture.calls, [{
    scanId: "scan-123",
    engine: "mantis",
    selection: request.connection,
    remoteRepositoryConfirmed: undefined,
  }]);
  assert.equal(selected.connectionAware, true);
  assert.equal(selected.model, "gpt-live");
  assert.equal(selected.request.model, "gpt-live");
  assert.equal(selected.request.authMode, "chatgpt");
  assert.equal(selected.request.provider, "openai");
});

test("connection launch does not fall through to the old Codex worker for an HTTP agent session", () => {
  const fixture = resolver(plan({
    routeKind: "openai-api",
    runnerKind: "agent-session",
    protocol: "openai-responses",
  }));

  assert.throws(() => resolveScanLaunchSelection({
    request: {
      repositoryPath: "/repo",
      engine: "mantis",
      connection: {
        connectionId: "openai-session",
        modelSelectionMode: "catalog",
        modelId: "gpt-live",
      },
    },
    scanId: "scan-123",
    launchPlans: fixture.resolver,
  }), (error: unknown) =>
    error instanceof ScanSelectionError && error.code === "provider_runner_unavailable");
  assert.equal(fixture.calls.length, 1);
});

test("unsupported HTTP runner stops before the launch callback can create output, config, or spawn", () => {
  const fixture = resolver(plan({
    routeKind: "openai-api",
    runnerKind: "agent-session",
    protocol: "openai-responses",
  }));
  let launchPreparationCalls = 0;

  assert.throws(() => resolveBeforeLaunch({
    request: {
      repositoryPath: "/repo",
      engine: "mantis",
      connection: {
        connectionId: "openai-session",
        modelSelectionMode: "catalog",
        modelId: "gpt-live",
      },
    },
    scanId: "scan-123",
    launchPlans: fixture.resolver,
    prepareLaunch: () => {
      launchPreparationCalls += 1;
      return "would-write-output-config-and-spawn";
    },
  }), (error: unknown) =>
    error instanceof ScanSelectionError && error.code === "provider_runner_unavailable");

  assert.equal(launchPreparationCalls, 0);
});

test("connection launch does not fall through to the old Codex worker for a remote job", () => {
  const fixture = resolver(plan({
    routeKind: "cursor-background-agents",
    runnerKind: "remote-agent-job",
    protocol: "cursor-background-agents",
  }));

  assert.throws(() => resolveScanLaunchSelection({
    request: {
      repositoryPath: "/repo",
      engine: "vulnhunter",
      remoteRepositoryConfirmed: true,
      connection: {
        connectionId: "openai-session",
        modelSelectionMode: "catalog",
        modelId: "gpt-live",
      },
    },
    scanId: "scan-123",
    launchPlans: fixture.resolver,
  }), (error: unknown) =>
    error instanceof ScanSelectionError && error.code === "provider_runner_unavailable");
  assert.equal(fixture.calls.length, 1);
  assert.deepEqual(fixture.calls, [{
    scanId: "scan-123",
    engine: "vulnhunter",
    selection: {
      connectionId: "openai-session",
      modelSelectionMode: "catalog",
      modelId: "gpt-live",
    },
    remoteRepositoryConfirmed: true,
  }]);
});

test("legacy launch does not resolve a connection plan", () => {
  const fixture = resolver(plan());
  const request: StartScanRequest = {
    repositoryPath: "/repo",
    engine: "codex-security",
    provider: "openai",
    model: "gpt-5.6-sol",
    authMode: "chatgpt",
  };

  const selected = resolveScanLaunchSelection({
    request,
    scanId: "scan-legacy",
    launchPlans: fixture.resolver,
  });

  assert.equal(selected.connectionAware, false);
  assert.equal(selected.model, null);
  assert.equal(selected.request, request);
  assert.deepEqual(fixture.calls, []);
});
