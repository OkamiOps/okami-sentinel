import type { GateExecutorKind } from "@csb/shared";

import type { EnrollGuardrailRepositoryRequest } from "../api.js";

export type GuardrailEnrollmentSource = "local" | "github";

export interface GuardrailEnrollmentState {
  source: GuardrailEnrollmentSource;
  repositoryPath: string;
  displayName: string;
  connectionId: string;
  installationId: string;
  repositoryId: string;
  defaultExecutor: GateExecutorKind;
}

export interface GuardrailExecutorAvailability {
  managed: boolean;
  actions: boolean;
}

export function initialEnrollmentState(): GuardrailEnrollmentState {
  return {
    source: "local",
    repositoryPath: "",
    displayName: "",
    connectionId: "",
    installationId: "",
    repositoryId: "",
    defaultExecutor: "sentinel-managed",
  };
}

export function selectEnrollmentSource(
  state: GuardrailEnrollmentState,
  source: GuardrailEnrollmentSource,
): GuardrailEnrollmentState {
  if (source === state.source) return state;
  return source === "local"
    ? {
        ...state,
        source,
        connectionId: "",
        installationId: "",
        repositoryId: "",
        defaultExecutor: "sentinel-managed",
      }
    : {
        ...state,
        source,
        repositoryPath: "",
        connectionId: "",
        installationId: "",
        repositoryId: "",
        defaultExecutor: "sentinel-managed",
      };
}

export function selectEnrollmentConnection(
  state: GuardrailEnrollmentState,
  connectionId: string,
): GuardrailEnrollmentState {
  return { ...state, connectionId, installationId: "", repositoryId: "" };
}

export function selectEnrollmentInstallation(
  state: GuardrailEnrollmentState,
  installationId: string,
): GuardrailEnrollmentState {
  return { ...state, installationId, repositoryId: "" };
}

export function canEnrollGuardrailRepository(
  state: GuardrailEnrollmentState,
  availability: GuardrailExecutorAvailability,
): boolean {
  if (state.source === "local") return state.repositoryPath.trim().length > 0;
  const executorReady = state.defaultExecutor === "github-actions"
    ? availability.actions
    : availability.managed;
  return executorReady
    && state.connectionId.length > 0
    && state.installationId.length > 0
    && state.repositoryId.length > 0;
}

export function enrollmentRequest(
  state: GuardrailEnrollmentState,
): EnrollGuardrailRepositoryRequest {
  const displayName = state.displayName.trim();
  if (state.source === "local") {
    return {
      source: "local",
      repositoryPath: state.repositoryPath.trim(),
      ...(displayName ? { displayName } : {}),
    };
  }
  return {
    source: "github",
    connectionId: state.connectionId,
    installationId: state.installationId,
    repositoryId: state.repositoryId,
    defaultExecutor: state.defaultExecutor,
    ...(displayName ? { displayName } : {}),
  };
}
