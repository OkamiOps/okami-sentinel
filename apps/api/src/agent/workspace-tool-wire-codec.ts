import {
  AgentSessionError,
  WORKSPACE_TOOL_NAMES,
  type WorkspaceToolName,
} from "./session-types.js";

const WIRE_SAFE_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const PORTABLE_WIRE_TOOL_NAMES = [
  ["workspace.list", "workspace_list"],
  ["workspace.read", "workspace_read"],
  ["workspace.search", "workspace_search"],
  ["results.write", "results_write"],
] as const satisfies readonly (readonly [WorkspaceToolName, string])[];

export interface WorkspaceToolWireCodec {
  toWire(internalName: WorkspaceToolName): string;
  toInternal(wireName: string): WorkspaceToolName | null;
}

/** Closed protocol codec; local tool names never cross an upstream wire. */
export const WORKSPACE_TOOL_WIRE_CODEC = createWorkspaceToolWireCodec();

function createWorkspaceToolWireCodec(): WorkspaceToolWireCodec {
  const toWire = new Map<WorkspaceToolName, string>();
  const toInternal = new Map<string, WorkspaceToolName>();
  for (const [internalName, wireName] of PORTABLE_WIRE_TOOL_NAMES) {
    if (!WIRE_SAFE_TOOL_NAME.test(wireName) || toWire.has(internalName) || toInternal.has(wireName)) {
      throw new AgentSessionError("runner_invalid_spec");
    }
    toWire.set(internalName, wireName);
    toInternal.set(wireName, internalName);
  }
  if (toWire.size !== WORKSPACE_TOOL_NAMES.length ||
      WORKSPACE_TOOL_NAMES.some((name) => !toWire.has(name))) {
    throw new AgentSessionError("runner_invalid_spec");
  }
  return {
    toWire(internalName: WorkspaceToolName): string {
      const wireName = toWire.get(internalName);
      if (wireName === undefined) throw new AgentSessionError("runner_invalid_spec");
      return wireName;
    },
    toInternal(wireName: string): WorkspaceToolName | null {
      return toInternal.get(wireName) ?? null;
    },
  };
}
