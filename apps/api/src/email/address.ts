import { DEFAULT_USER_LOCALE, isUserLocale, type UserLocale } from "@csb/shared";

/**
 * Deliberately narrower than RFC 5322. Everything this API does with an address
 * is put it in a `To:` or `From:` header and hand it to a provider, so the only
 * useful question is whether it is an unambiguous, header-safe `local@domain`
 * with a real domain label. Quoted local parts, comments, bare-hostname domains
 * and address lists are all refused rather than passed through to a provider
 * that would reject them later, or worse, accept a folded header.
 */
const ADDRESS = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

export function isEmailAddress(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && ADDRESS.test(value);
}

export interface AddressableUser {
  email: string | null;
  username: string;
}

/**
 * Where a user's mail goes, in the order the design fixes: the explicit
 * `users.email`, then the `username` when the team signs in with work
 * addresses, and otherwise nowhere — Minha conta says so instead of the API
 * inventing a destination.
 */
export function resolveUserEmailAddress(user: AddressableUser): string | null {
  const explicit = user.email?.trim() ?? "";
  if (isEmailAddress(explicit)) return explicit;
  const username = user.username.trim();
  return isEmailAddress(username) ? username : null;
}

/** `users.locale` if the user chose one, the default otherwise. */
export function localeOf(user: { locale: string | null }): UserLocale {
  return isUserLocale(user.locale) ? user.locale : DEFAULT_USER_LOCALE;
}
