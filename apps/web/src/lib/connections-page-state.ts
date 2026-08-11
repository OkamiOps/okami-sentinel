export type ConnectionsLoadState = "loading" | "error" | "empty" | "ready";

export function connectionsLoadState(
  connections: Array<unknown> | null,
  error: string | null,
): ConnectionsLoadState {
  if (connections === null) return error ? "error" : "loading";
  return connections.length === 0 ? "empty" : "ready";
}

export type MonotonicRequestGuard = {
  (): () => boolean;
  invalidate(): void;
};

export function createMonotonicRequestGuard(): MonotonicRequestGuard {
  let latestRequest = 0;
  const beginRequest = (() => {
    const request = ++latestRequest;
    return () => request === latestRequest;
  }) as MonotonicRequestGuard;

  beginRequest.invalidate = () => { latestRequest += 1; };
  return beginRequest;
}
