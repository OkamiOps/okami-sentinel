export interface TelemetryState {
  lines: string[];
  cursor: number;
  volatileLines: string[];
}

export interface TelemetryEvent {
  message?: string;
  cursor?: number;
}

const MAX_LINES = 500;

export function telemetrySnapshot(lines: string[], cursor: number): TelemetryState {
  return {
    lines: lines.slice(-MAX_LINES),
    cursor: Number.isFinite(cursor) ? Math.max(0, Math.trunc(cursor)) : 0,
    volatileLines: [],
  };
}

export function mergeTelemetrySnapshot(
  state: TelemetryState,
  lines: string[],
  cursor: number,
): TelemetryState {
  const snapshot = telemetrySnapshot(lines, cursor);
  if (snapshot.cursor <= state.cursor) return state;
  const volatileLines = state.volatileLines.slice(-MAX_LINES);
  return {
    lines: [...snapshot.lines, ...volatileLines].slice(-MAX_LINES),
    cursor: snapshot.cursor,
    volatileLines,
  };
}

export function appendTelemetryEvent(
  state: TelemetryState,
  event: TelemetryEvent,
): TelemetryState {
  if (!event.message) return state;
  if (event.cursor !== undefined && event.cursor <= state.cursor) return state;
  const volatileLines = event.cursor === undefined
    ? [...state.volatileLines, event.message].slice(-MAX_LINES)
    : state.volatileLines;
  return {
    lines: [...state.lines.slice(-(MAX_LINES - 1)), event.message],
    cursor: event.cursor === undefined ? state.cursor : Math.max(state.cursor, event.cursor),
    volatileLines,
  };
}
