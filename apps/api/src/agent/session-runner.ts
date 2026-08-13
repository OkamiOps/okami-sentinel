import type { ModelCapabilities } from "@csb/shared";

import { createAnthropicMessagesWireAdapter } from "./anthropic-messages-session.js";
import { createOpenAiChatWireAdapter } from "./openai-chat-session.js";
import { createOpenAiResponsesWireAdapter } from "./openai-responses-session.js";
import { PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT } from "./result-artifact-contract.js";
import { MANTIS_REPORT_RESULT_ARTIFACT_CONTRACT } from "../scanners/mantis-report-contract.js";
import { createWorkspaceToolHost } from "./workspace-tool-host.js";
import {
  AgentSessionError,
  MAX_AGENT_SESSION_COMPLETION_TOKENS,
  createConstrainedWireSession,
  validateAgentSessionReasoningEffort,
  validateAgentSessionLimits,
  type AgentSession,
  type AgentSessionLimits,
  type AgentUpstream,
  type CreateAgentSessionInput,
  type WireSessionAdapter,
} from "./session-types.js";

export const DEFAULT_AGENT_LIMITS: Readonly<AgentSessionLimits> = Object.freeze({
  maxModelTurns: 32,
  maxToolCalls: 96,
  maxInputBytes: 67_108_864,
  maxOutputBytes: 16_777_216,
  timeoutMs: 5_400_000,
});

/**
 * Creates an agent only after an exact selected-model probe has measured the
 * tool/artifact/structured loop. It accepts an injected upstream, never fetch.
 */
export async function createAgentSession(
  input: CreateAgentSessionInput,
  upstream?: AgentUpstream,
): Promise<AgentSession> {
  if (!supportsAgentSession(capabilitiesFrom(input.probe))) {
    throw new AgentSessionError("runner_capability_missing");
  }
  validateSessionSpec(input);
  if (upstream === undefined || typeof upstream.request !== "function") {
    throw new AgentSessionError("runner_upstream_required");
  }

  const host = await createWorkspaceToolHost({
    snapshotRoot: input.snapshotRoot,
    artifactRoot: input.artifactRoot,
    maxReadBytes: Math.min(input.limits.maxOutputBytes, 4 * 1_048_576),
    maxWriteBytes: input.limits.maxOutputBytes,
  });
  return createConstrainedWireSession({
    limits: input.limits,
    signal: input.signal,
    host,
    upstream,
    adapter: adapterFor(input),
    ...(input.terminalMode === undefined ? {} : { terminalMode: input.terminalMode }),
    ...(input.artifactWriteByTurn === undefined
      ? {}
      : { artifactWriteByTurn: input.artifactWriteByTurn }),
    ...(input.resultArtifactContract === undefined
      ? {}
      : {
        resultArtifactContract: input.resultArtifactContract,
        resultArtifactSnapshotRoot: input.snapshotRoot,
        ...(input.resultArtifactValidationContext === undefined
          ? {}
          : { resultArtifactValidationContext: input.resultArtifactValidationContext }),
      }),
  });
}

function adapterFor(input: CreateAgentSessionInput): WireSessionAdapter {
  switch (input.protocol) {
    case "openai-chat":
      return createOpenAiChatWireAdapter({
        model: input.model,
        instructions: input.instructions,
        routeKind: input.routeKind,
        ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
        ...(input.resultArtifactContract === undefined
          ? {}
          : { resultArtifactContract: input.resultArtifactContract }),
      });
    case "openai-responses":
    case "xai-oauth-responses":
      return createOpenAiResponsesWireAdapter(input);
    case "anthropic-messages":
      return createAnthropicMessagesWireAdapter(input);
    default:
      throw new AgentSessionError("runner_protocol_unsupported");
  }
}

function capabilitiesFrom(
  probe: CreateAgentSessionInput["probe"],
): ModelCapabilities {
  if ("capabilities" in probe) return probe.capabilities;
  return probe;
}

function supportsAgentSession(capabilities: ModelCapabilities): boolean {
  return capabilities.tools === "supported" &&
    capabilities.artifactOutput === "supported" &&
    capabilities.structuredOutput === "supported" &&
    capabilities.boundedExecution === "supported";
}

function validateSessionSpec(input: CreateAgentSessionInput): void {
  if (!isNonEmptyString(input.connectionId) || !isNonEmptyString(input.routeKind) ||
      !isNonEmptyString(input.instructions) || !isNonEmptyString(input.snapshotRoot) ||
      !isNonEmptyString(input.artifactRoot) || !isAbortSignal(input.signal) ||
      !isNonEmptyString(input.model?.id) || input.model.connectionId !== input.connectionId ||
      (input.maxCompletionTokens !== undefined &&
        (!Number.isSafeInteger(input.maxCompletionTokens) || input.maxCompletionTokens <= 0 ||
          input.maxCompletionTokens > MAX_AGENT_SESSION_COMPLETION_TOKENS)) ||
      (input.terminalMode !== undefined &&
        input.terminalMode !== "provider-completion" && input.terminalMode !== "artifact-write") ||
      (input.artifactWriteByTurn !== undefined &&
        (!Number.isSafeInteger(input.artifactWriteByTurn) ||
          input.artifactWriteByTurn < 0 ||
          input.artifactWriteByTurn >= input.limits.maxModelTurns ||
          input.terminalMode !== "artifact-write")) ||
      (input.resultArtifactContract !== undefined &&
        input.resultArtifactContract !== "vulnhunter-report-v1" &&
        input.resultArtifactContract !== PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT &&
        input.resultArtifactContract !== MANTIS_REPORT_RESULT_ARTIFACT_CONTRACT) ||
      (input.resultArtifactContract === PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT &&
        input.resultArtifactValidationContext === undefined) ||
      (input.resultArtifactContract !== PORTABLE_STAGE_RESULT_ARTIFACT_CONTRACT &&
        input.resultArtifactValidationContext !== undefined)) {
    throw new AgentSessionError("runner_invalid_spec");
  }
  validateAgentSessionLimits(input.limits);
  validateAgentSessionReasoningEffort(
    input.model,
    input.reasoningEffort,
    input.routeKind,
    input.protocol,
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === "object" && value !== null &&
    typeof (value as AbortSignal).aborted === "boolean" &&
    typeof (value as AbortSignal).addEventListener === "function";
}
