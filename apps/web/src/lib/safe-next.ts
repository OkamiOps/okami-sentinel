export function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (value === "/login" || value.startsWith("/login?") || value.startsWith("/invite/")) return "/";
  return value;
}
