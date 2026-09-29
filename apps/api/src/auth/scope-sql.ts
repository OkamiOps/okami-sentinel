import type { AccessScope } from "./principal.js";

export function scopeSql(scope: AccessScope, column: string): { sql: string; params: string[] } {
  if (scope.kind === "all") return { sql: "", params: [] };
  const keys = [...scope.keys];
  if (keys.length === 0) return { sql: " AND 0", params: [] };
  return { sql: ` AND ${column} IN (${keys.map(() => "?").join(", ")})`, params: keys };
}
