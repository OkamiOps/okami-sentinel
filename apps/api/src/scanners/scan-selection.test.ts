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

test("Mantis HTTP agent sessions retain the server plan instead of mapping to the old Codex worker", () => {
  const fixture = resolver(plan({
    routeKind: "openai-api",
    runnerKind: "agent-session",
    protocol: "openai-responses",
    capabilityCheckId: "capability-a",
  }));

  const selected = resolveScanLaunchSelection({
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
  });
  assert.equal(fixture.calls.length, 1);
  assert.equal(selected.connectionAware, true);
  assert.equal(selected.model, "gpt-live");
  assert.equal(selected.request.model, "gpt-live");
  assert.equal(selected.request.authMode, "api-key");
  assert.equal(selected.plan?.runnerKind, "agent-session");
});

test("Claude local runtime-default strips browser provider, model, and auth injection", () => {
  const fixture = resolver(plan({
    connectionId: "claude-local-session",
    providerKind: "anthropic",
    routeKind: "claude-code-local",
    runnerKind: "local-agent-session" as ScanLaunchPlan["runnerKind"],
    protocol: "claude-code-cli",
    model: null,
    capabilityCheckId: null,
    scannerAuthMode: "existing-session" as ScanLaunchPlan["scannerAuthMode"],
    snapshot: {
      scanId: "scan-claude-local",
      connectionId: "claude-local-session",
      routeKind: "claude-code-local",
      modelSelectionMode: "runtime-default",
      modelId: null,
      capabilityCheckId: null,
      capturedAt: "2026-08-11T12:00:00.000Z",
    },
  }));

  const selected = resolveScanLaunchSelection({
    request: {
      repositoryPath: "/repo",
      engine: "mantis",
      provider: "browser-injected-provider",
      model: "browser-injected-model",
      authMode: "api-key",
      connection: {
        connectionId: "claude-local-session",
        modelSelectionMode: "runtime-default",
        modelId: null,
      },
    },
    scanId: "scan-claude-local",
    launchPlans: fixture.resolver,
  });

  assert.equal(selected.connectionAware, true);
  assert.equal(selected.model, null);
  assert.equal(selected.request.provider, "anthropic");
  assert.equal(selected.request.authMode, "existing-session");
  assert.equal("model" in selected.request, false);
  assert.equal(selected.plan?.runnerKind, "local-agent-session");
});

test("VulnHunter accepts only a verified HTTP agent-session plan for its dedicated runner", () => {
  const fixture = resolver(plan({
    engine: "vulnhunter",
    routeKind: "openai-api",
    runnerKind: "agent-session",
    protocol: "openai-responses",
    scannerAuthMode: undefined,
    snapshot: {
      scanId: "scan-vulnhunter-http",
      connectionId: "openai-session",
      routeKind: "openai-api",
      modelSelectionMode: "catalog",
      modelId: "gpt-live",
      capabilityCheckId: "probe-live",
      capturedAt: "2026-08-11T12:00:00.000Z",
    },
    capabilityCheckId: "probe-live",
  }));

  const selected = resolveScanLaunchSelection({
    request: {
      repositoryPath: "/repo",
      engine: "vulnhunter",
      connection: {
        connectionId: "openai-session",
        modelSelectionMode: "catalog",
        modelId: "gpt-live",
      },
    },
    scanId: "scan-vulnhunter-http",
    launchPlans: fixture.resolver,
  });

  assert.equal(selected.connectionAware, true);
  assert.equal(selected.model, "gpt-live");
  assert.equal(selected.plan?.runnerKind, "agent-session");
  assert.equal(selected.request.authMode, undefined);
});

test("VulnHunter accepts direct xAI OAuth only for the pinned xAI route", () => {
  const xaiModel: ProviderModel = {
    ...model,
    connectionId: "xai-oauth-session",
    id: "grok-live",
  };
  const fixture = resolver(plan({
    engine: "vulnhunter",
    connectionId: "xai-oauth-session",
    providerKind: "xai",
    routeKind: "xai-oauth",
    runnerKind: "agent-session",
    protocol: "xai-oauth-responses",
    model: xaiModel,
    scannerAuthMode: undefined,
    snapshot: {
      scanId: "scan-vulnhunter-xai",
      connectionId: "xai-oauth-session",
      routeKind: "xai-oauth",
      modelSelectionMode: "catalog",
      modelId: "grok-live",
      capabilityCheckId: "probe-xai",
      capturedAt: "2026-08-11T12:00:00.000Z",
    },
    capabilityCheckId: "probe-xai",
  }));

  const selected = resolveScanLaunchSelection({
    request: {
      repositoryPath: "/repo",
      engine: "vulnhunter",
      connection: {
        connectionId: "xai-oauth-session",
        modelSelectionMode: "catalog",
        modelId: "grok-live",
      },
    },
    scanId: "scan-vulnhunter-xai",
    launchPlans: fixture.resolver,
  });

  assert.equal(selected.plan?.providerKind, "xai");
  assert.equal(selected.plan?.protocol, "xai-oauth-responses");
});

test("VulnHunter rejects xAI OAuth plans without the pinned xAI provider", () => {
  const fixture = resolver(plan({
    engine: "vulnhunter",
    providerKind: "openai",
    routeKind: "xai-oauth",
    runnerKind: "agent-session",
    protocol: "xai-oauth-responses",
    scannerAuthMode: undefined,
    snapshot: {
      scanId: "scan-vulnhunter-xai-invalid",
      connectionId: "openai-session",
      routeKind: "xai-oauth",
      modelSelectionMode: "catalog",
      modelId: "gpt-live",
      capabilityCheckId: "probe-xai-invalid",
      capturedAt: "2026-08-11T12:00:00.000Z",
    },
    capabilityCheckId: "probe-xai-invalid",
  }));

  assert.throws(() => resolveScanLaunchSelection({
    request: {
      repositoryPath: "/repo",
      engine: "vulnhunter",
      connection: {
        connectionId: "openai-session",
        modelSelectionMode: "catalog",
        modelId: "gpt-live",
      },
    },
    scanId: "scan-vulnhunter-xai-invalid",
    launchPlans: fixture.resolver,
  }), (error: unknown) =>
    error instanceof ScanSelectionError && error.code === "provider_runner_unavailable");
});

test("Mantis accepts direct xAI OAuth only for the pinned xAI route", () => {
  const xaiModel: ProviderModel = {
    ...model,
    connectionId: "xai-oauth-session",
    id: "grok-live",
  };
  const fixture = resolver(plan({
    connectionId: "xai-oauth-session",
    providerKind: "xai",
    routeKind: "xai-oauth",
    runnerKind: "agent-session",
    protocol: "xai-oauth-responses",
    capabilityCheckId: "capability-a",
    model: xaiModel,
    snapshot: {
      scanId: "scan-xai-mantis",
      connectionId: "xai-oauth-session",
      routeKind: "xai-oauth",
      modelSelectionMode: "catalog",
      modelId: "grok-live",
      capabilityCheckId: "capability-a",
      capturedAt: "2026-08-11T12:00:00.000Z",
    },
  }));
  let launchPreparationCalls = 0;

  const selected = resolveBeforeLaunch({
    request: {
      repositoryPath: "/repo",
      engine: "mantis",
      connection: {
        connectionId: "xai-oauth-session",
        modelSelectionMode: "catalog",
        modelId: "grok-live",
      },
    },
    scanId: "scan-xai-mantis",
    launchPlans: fixture.resolver,
    prepareLaunch: () => {
      launchPreparationCalls += 1;
      return "would-write-output-config-and-spawn";
    },
  });

  assert.equal(selected.selection.plan?.providerKind, "xai");
  assert.equal(selected.selection.plan?.protocol, "xai-oauth-responses");
  assert.equal(launchPreparationCalls, 1);
});

test("Codex Security OpenAI API accepts only the resolved catalog plan, never client or global auth", () => {
  const fixture = resolver(plan({
    engine: "codex-security",
    routeKind: "openai-api",
    runnerKind: "codex-security-contract",
    protocol: "openai-responses",
    scannerAuthMode: "api-key",
    snapshot: {
      scanId: "scan-codex-api",
      connectionId: "openai-session",
      routeKind: "openai-api",
      modelSelectionMode: "catalog",
      modelId: "gpt-live",
      capabilityCheckId: null,
      capturedAt: "2026-08-11T12:00:00.000Z",
    },
  }));
  let launchPreparationCalls = 0;
  const result = resolveBeforeLaunch({
    request: {
      repositoryPath: "/repo",
      engine: "codex-security",
      provider: "openai",
      model: "client-spoofed-model",
      authMode: "api-key",
      connection: {
        connectionId: "openai-session",
        modelSelectionMode: "catalog",
        modelId: "gpt-live",
      },
    },
    scanId: "scan-codex-api",
    launchPlans: fixture.resolver,
    prepareLaunch: (selection) => {
      launchPreparationCalls += 1;
      return selection.request;
    },
  });

  assert.equal(result.selection.request.provider, "openai");
  assert.equal(result.selection.request.model, "gpt-live");
  assert.equal(result.selection.request.authMode, "api-key");
  assert.equal(result.launch.model, "gpt-live");
  assert.equal(result.launch.authMode, "api-key");

  assert.equal(launchPreparationCalls, 1);
});

test("Codex Security keeps the two scoped local session routes launchable", () => {
  for (const routeKind of [
    "openai-codex-local",
    "openai-chatgpt-app-server",
  ] as const) {
    const fixture = resolver(plan({
      engine: "codex-security",
      routeKind,
      runnerKind: "codex-security-contract",
      protocol: "codex-app-server",
      scannerAuthMode: "chatgpt",
    }));
    let launchPreparationCalls = 0;

    const result = resolveBeforeLaunch({
      request: {
        repositoryPath: "/repo",
        engine: "codex-security",
        connection: {
          connectionId: "openai-session",
          modelSelectionMode: "catalog",
          modelId: "gpt-live",
        },
      },
      scanId: `scan-${routeKind}`,
      launchPlans: fixture.resolver,
      prepareLaunch: (selection) => {
        launchPreparationCalls += 1;
        return selection.request.authMode;
      },
    });

    assert.equal(launchPreparationCalls, 1);
    assert.equal(result.launch, "chatgpt");
  }
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
