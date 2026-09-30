let draining = false;
export function isDraining(): boolean { return draining; }

export function createShutdownHandler(dependencies: {
  stopHttp(): void;
  cancelWork(): boolean;
  closeStore(): void;
  /**
   * Background loops that own the store: awaited after the timers are cleared
   * and before the store closes, so an in-flight iteration finishes its write
   * instead of resolving into a closed database.
   */
  drain?: () => Promise<void>;
  wait?: (milliseconds: number) => Promise<void>;
}): () => Promise<void> {
  let pending: Promise<void> | null = null;
  return () => {
    if (pending) return pending;
    draining = true;
    pending = (async () => {
      dependencies.stopHttp();
      const hadWork = dependencies.cancelWork();
      // Existing verified cancellation escalates SIGTERM to SIGKILL after 5s.
      if (hadWork) await (dependencies.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(6_000);
      await dependencies.drain?.().catch(() => undefined);
      dependencies.closeStore();
    })();
    return pending;
  };
}
