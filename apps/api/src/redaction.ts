const REDACTED = "[REDACTED]";
const SENSITIVE_NAME = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret)/i;
const SENSITIVE_FIELD = "(?:authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|cookie|password|secret)";

export class SecretRedactor {
  readonly #scopes = new Map<string, Set<string>>();

  register(scope: string, values: Iterable<string>): void {
    const safe = new Set([...values].map((value) => value.trim()).filter((value) => value.length >= 4));
    if (safe.size === 0) this.#scopes.delete(scope);
    else this.#scopes.set(scope, safe);
  }

  unregister(scope: string): void {
    this.#scopes.delete(scope);
  }

  redactText(input: string): string {
    const exact = [...new Set([...this.#scopes.values()].flatMap((values) => [...values]))]
      .sort((left, right) => right.length - left.length);
    let output = input;
    for (const value of exact) output = output.split(value).join(REDACTED);
    output = output.replace(
      new RegExp(`((?:"${SENSITIVE_FIELD}"|${SENSITIVE_FIELD})\\s*[:=]\\s*")([^\"]*)"`, "gi"),
      `$1${REDACTED}"`,
    );
    output = output.replace(
      new RegExp(`((?:"${SENSITIVE_FIELD}"|${SENSITIVE_FIELD})\\s*[:=]\\s*')([^']*)'`, "gi"),
      `$1${REDACTED}'`,
    );
    output = output.replace(
      new RegExp(`(${SENSITIVE_FIELD}\\s*[:=]\\s*)(?:bearer|basic)?\\s*[^\\s,;"}]+`, "gi"),
      `$1${REDACTED}`,
    );
    output = output.replace(
      new RegExp(`((?:"${SENSITIVE_FIELD}"|${SENSITIVE_FIELD})\\s*[:=]\\s*)(?!(?:["']|\\[REDACTED\\]))[^\\s,;}&]+`, "gi"),
      `$1"${REDACTED}"`,
    );
    output = output.replace(
      /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)=)[^&#\s]+/gi,
      `$1${REDACTED}`,
    );
    return output;
  }
}

export const globalSecretRedactor = new SecretRedactor();
export const redactText = (value: string): string => globalSecretRedactor.redactText(value);
export const redactErrorMessage = (error: unknown): string =>
  redactText(error instanceof Error ? error.message : "Unexpected provider error");

export function processSecretValues(environment: NodeJS.ProcessEnv | Record<string, string | undefined>): string[] {
  return Object.entries(environment)
    .filter(([name, value]) => SENSITIVE_NAME.test(name) && typeof value === "string" && value.length >= 4)
    .map(([, value]) => value!);
}
