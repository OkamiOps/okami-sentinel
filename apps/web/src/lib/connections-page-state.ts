export type ConnectionsLoadState = "loading" | "error" | "empty" | "ready";

export function connectionsLoadState(
  connections: Array<unknown> | null,
  error: string | null,
): ConnectionsLoadState {
  if (connections === null) return error ? "error" : "loading";
  return connections.length === 0 ? "empty" : "ready";
}
