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
  ["workspace.graph", "workspace_graph"],
  ["results.write", "results_write"],
] as const satisfies readonly (readonly [WorkspaceToolName, string])[];

export interface WorkspaceToolWireCodec {
  toWire(internalName: WorkspaceToolName): string;
  toInternal(wireName: string): WorkspaceToolName | null;
}

/** Closed protocol codec; local tool names never cross an upstream wire. */
export const WORKSPACE_TOOL_WIRE_CODEC = createWorkspaceToolWireCodec();

/** Provider-neutral path contract shown on every upstream tool declaration. */
export const WORKSPACE_TOOL_WIRE_DESCRIPTIONS = {
  "workspace.list": "List read-only files. Use '.' for the virtual root or a repository-relative path; never use an absolute path.",
  "workspace.read": "Read one complete regular file using a repository-relative path; never use an absolute path or a directory (use the listing tool for directories). This tool never truncates: maxBytes is an optional hard full-file limit, so omit it unless you know the whole file fits; a too-small value rejects the read.",
  "workspace.search": "Search read-only files using '.' for the virtual root or a repository-relative path; never use an absolute path.",
  "workspace.graph": "Find related source symbols and relationships in the read-only snapshot graph using a short literal query (1-200 characters), with maxResults limiting matching symbols to at most 20, plus a byte-bounded one-hop neighborhood. Graph relations are navigation hints, not proof of vulnerability or completed file review: verify evidence using workspace_read. No commands, paths to indexes, or arbitrary graph expressions are accepted.",
  "results.write": "Write a result artifact using a result-relative path; never use an absolute path.",
} as const satisfies Record<WorkspaceToolName, string>;

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
