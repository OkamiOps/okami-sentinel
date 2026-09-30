import {
  OPS_NOTIFICATION_SCOPE,
  UNASSIGNED_NOTIFICATION_SCOPE,
  type AccountNotificationsResponse,
  type NotificationEvent,
  type NotificationEventState,
} from "@csb/shared";

/**
 * A cell's address in the matrix. `scope` is a repository key or one of the two
 * reserved scopes, which is exactly what `PUT /account/notifications` accepts,
 * so the optimistic edit and the request can never disagree about which cell
 * was toggled.
 */
export interface NotificationCell {
  scope: string;
  event: NotificationEvent;
}

function withEvent(events: NotificationEventState[], event: NotificationEvent, state: NotificationEventState): NotificationEventState[] {
  return events.map((current) => current.event === event ? { ...state, event } : current);
}

/**
 * Write one cell's whole state. Every edit — optimistic, confirmed and rolled
 * back — goes through this single rewrite, and it touches exactly one cell:
 * two toggles in flight at once must not be able to undo each other, which is
 * what replacing the whole matrix from a reply used to do.
 */
export function withCellState(
  matrix: AccountNotificationsResponse,
  cell: NotificationCell,
  state: NotificationEventState | null,
): AccountNotificationsResponse {
  // A cell the reply does not carry (a repository that stopped being shared
  // between the click and the answer) leaves the matrix as it is; the next
  // read is what corrects the shape.
  if (state === null) return matrix;
  if (cell.scope === OPS_NOTIFICATION_SCOPE) {
    return matrix.ops === null ? matrix : { ...matrix, ops: { events: withEvent(matrix.ops.events, cell.event, state) } };
  }
  if (cell.scope === UNASSIGNED_NOTIFICATION_SCOPE) {
    return matrix.unassigned === null
      ? matrix
      : { ...matrix, unassigned: { events: withEvent(matrix.unassigned.events, cell.event, state) } };
  }
  return {
    ...matrix,
    repositories: matrix.repositories.map((repository) => repository.repositoryKey === cell.scope
      ? { ...repository, events: withEvent(repository.events, cell.event, state) }
      : repository),
  };
}

/**
 * The optimistic edit: a cell set back to its default is still a choice the
 * user made, and the API records it as a row, so `isDefault` has to stop
 * claiming otherwise.
 */
export function withCell(
  matrix: AccountNotificationsResponse,
  cell: NotificationCell,
  enabled: boolean,
): AccountNotificationsResponse {
  return withCellState(matrix, cell, { event: cell.event, enabled, isDefault: false });
}

/** What a cell currently holds, or `null` when the matrix has no such cell. */
export function cellState(matrix: AccountNotificationsResponse, cell: NotificationCell): NotificationEventState | null {
  const events = cell.scope === OPS_NOTIFICATION_SCOPE
    ? matrix.ops?.events
    : cell.scope === UNASSIGNED_NOTIFICATION_SCOPE
      ? matrix.unassigned?.events
      : matrix.repositories.find((repository) => repository.repositoryKey === cell.scope)?.events;
  return events?.find((state) => state.event === cell.event) ?? null;
}

/** A stable key for React and for a pending-cell set. */
export function cellKey(cell: NotificationCell): string {
  return `${cell.scope}\u0000${cell.event}`;
}
