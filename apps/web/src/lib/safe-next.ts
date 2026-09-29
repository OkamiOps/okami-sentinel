export function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  // Compare the path only: a query or hash suffix (`/login#x`, `/login?next=/x`)
  // must not smuggle a loop back into the auth flow past this check.
  const path = value.split(/[?#]/, 1)[0];
  if (path === "/login" || path.startsWith("/invite/")) return "/";
  return value;
}
