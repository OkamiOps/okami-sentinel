import type { GateEvent, GateEventPayload, GateEventType } from "./gate-store.js";

export type GateEventListener = (event: GateEvent) => void;

export interface GateEventPersistence {
  appendGateEvent(gateId: string, event: GateEvent): void;
  listGateEvents(gateId: string): GateEvent[];
}

const listeners = new Map<string, Set<GateEventListener>>();

export function publishGateEvent(
  gateId: string,
  type: GateEventType,
  payload: GateEventPayload,
  createdAt: string,
  persistence: GateEventPersistence,
): GateEvent {
  const persisted = persistence.listGateEvents(gateId);
  const event: GateEvent = {
    sequence: (persisted.at(-1)?.sequence ?? 0) + 1,
    type,
    payload,
    createdAt,
  };
  persistence.appendGateEvent(gateId, event);
  for (const listener of listeners.get(gateId) ?? []) listener(event);
  return event;
}

export function subscribePersistedGateEvents(
  gateId: string,
  listener: GateEventListener,
  persistence: GateEventPersistence,
): () => void {
  for (const event of persistence.listGateEvents(gateId)) listener(event);
  let gateListeners = listeners.get(gateId);
  if (!gateListeners) {
    gateListeners = new Set();
    listeners.set(gateId, gateListeners);
  }
  gateListeners.add(listener);
  return () => {
    gateListeners!.delete(listener);
    if (gateListeners!.size === 0) listeners.delete(gateId);
  };
}
