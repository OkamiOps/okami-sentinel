/**
 * The server stores usernames trimmed and lowercased and refuses anything
 * outside `[a-z0-9._@+-]{2,64}` (`normalizeUsername` in
 * `apps/api/src/auth/user-store.ts`). The invite form previews the same
 * normalization so " Bruno.Lima " is shown as the `bruno.lima` it will become,
 * and " Marcos@OkamiOps.com " as the `marcos@okamiops.com` it will become,
 * instead of landing under a name the administrator never read.
 */
export function normalizeUsername(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9._@+-]{2,64}$/.test(normalized) ? normalized : null;
}

/**
 * Usernames are shown as handles, which is why they carry an `@` prefix. A
 * username that is itself an email address already has one, so it is shown as
 * the address it is instead of as `@marcos@okamiops.com`.
 */
export function formatHandle(username: string): string {
  return username.includes("@") ? username : `@${username}`;
}
