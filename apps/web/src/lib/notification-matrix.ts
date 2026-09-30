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

function withEvent(events: NotificationEventState[], event: NotificationEvent, enabled: boolean): NotificationEventState[] {
  return events.map((state) => state.event === event
    // A cell set back to its default is still a choice the user made, and the
    // API records it as a row; `isDefault` has to stop claiming otherwise.
    ? { ...state, enabled, isDefault: false }
    : state);
}

/**
 * The optimistic edit and the rollback both go through this one rewrite, so a
 * refusal restores the stored matrix by replaying the previous value instead of
 * re-reading the whole response.
 */
export function withCell(
  matrix: AccountNotificationsResponse,
  cell: NotificationCell,
  enabled: boolean,
): AccountNotificationsResponse {
  if (cell.scope === OPS_NOTIFICATION_SCOPE) {
    return matrix.ops === null ? matrix : { ...matrix, ops: { events: withEvent(matrix.ops.events, cell.event, enabled) } };
  }
  if (cell.scope === UNASSIGNED_NOTIFICATION_SCOPE) {
    return matrix.unassigned === null
      ? matrix
      : { ...matrix, unassigned: { events: withEvent(matrix.unassigned.events, cell.event, enabled) } };
  }
  return {
    ...matrix,
    repositories: matrix.repositories.map((repository) => repository.repositoryKey === cell.scope
      ? { ...repository, events: withEvent(repository.events, cell.event, enabled) }
      : repository),
  };
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
