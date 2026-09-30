/**
 * A failure named by its kind and nothing else.
 *
 * An exception's message is written by whoever threw it — a provider, a SQLite
 * driver, a module loader — and this feature's exceptions travel next to e-mail
 * addresses, subjects and single-use tokens. So the log gets the two parts that
 * cannot carry any of them: the error's name and, when it has one, its code.
 *
 * One copy, because every logger in the feature needs exactly this and a fifth
 * duplicate is how the invariant would eventually decay.
 */
export function failureKind(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code: unknown }).code
    : undefined;
  const name = error instanceof Error ? error.name : "unknown_error";
  return typeof code === "string" && code !== "" ? `${name}/${code}` : name;
}
