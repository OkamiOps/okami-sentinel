// Shared by the artifact validator and the scanner-text redactor so that
// redacted text is always accepted by validation: both sides use one rule set.

export function containsSecret(value: string): boolean {
  return containsSecretAssignment(value)
    || containsBearerCredential(value)
    || containsCommonToken(value);
}

export function containsLocalHostPath(value: string): boolean {
  return /file:\/\//i.test(value)
    || /(?:^|[\s"'`\[({=,:])\\\\[^\\/\s,;|\]})>`'"]+[\\/][^\s,;|\]})>`'"]*/.test(value)
    || /(?:^|[\s"'`\[({=,:])[A-Za-z]:[\\/][^\s,;|\]})>`'"]*/.test(value)
    || /(?:^|[\s"'`\[({=,:])\/(?:Users|tmp|private|root|var\/folders|var\/tmp)(?=\/|[\s,;|\]})>`'"]|$)/.test(value)
    || /(?:^|[\s"'`\[({=,:])\/home\/[^/\s,;|\]})>`'"]+(?:\/[^\s,;|\]})>`'"]*)?/.test(value);
}

export function isRepositoryRelativePath(value: string): boolean {
  if (value !== value.trim()) return false;
  const location = value.replace(/:\d+(?::\d+)?(?:-\d+)?$/, "").replaceAll("\\", "/");
  if (
    /^~(?:\/|$)/.test(location)
    || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(location)
    || /^[A-Za-z]:/.test(location)
    || /^\//.test(location)
  ) {
    return false;
  }
  return !location.split("/").includes("..");
}

/**
 * Replaces credentials and host paths with placeholders. Text that still looks
 * unsafe after targeted redaction is replaced whole, so the result always
 * passes `containsSecret` and `containsLocalHostPath`.
 */
export function redactPublicText(value: string): string {
  let redacted = redactSecretAssignments(value);
  redacted = redactBearerCredentials(redacted)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gi, "[REDACTED]")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/gi, "[REDACTED]")
    .replace(/\bglpat-[A-Za-z0-9_-]{20,}\b/gi, "[REDACTED]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gi, "[REDACTED]")
    .replace(/\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/gi, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]");
  redacted = redactLocalHostPaths(redacted);
  return containsSecret(redacted) || containsLocalHostPath(redacted) ? "[REDACTED]" : redacted;
}

function containsSecretAssignment(value: string): boolean {
  return /(?:^|[^A-Za-z0-9_])(?:[A-Za-z0-9]+_)*(?:SECRET_ACCESS_KEY|API_KEY|ACCESS_KEY|TOKEN|SECRET|PASSWORD)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\s,;|]+)/i.test(value)
    || /\b(?:authorization|api[- ]?key|token|secret|password)\s*[:=]\s*(?:bearer\s+)?(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\s,;|]+)/i.test(value);
}

function containsBearerCredential(value: string): boolean {
  const matches = value.matchAll(/\bbearer\s+([^\s,;|]+)/gi);
  for (const match of matches) {
    if (isCredentialLikeBearerValue(match[1] ?? "")) return true;
  }
  return false;
}

// Security findings routinely describe the Bearer scheme in prose ("the bearer
// is absent"), so the value must look like a token rather than a word: it has
// a digit, token punctuation, or opaque-token length.
function isCredentialLikeBearerValue(value: string): boolean {
  const candidate = value.replace(/^[`'"\[({]+|[`'"\])}.:!?]+$/g, "");
  if (!candidate) return false;
  if (/^(?:token|credential|authentication|authorization|header|scheme|absent|missing|omitted|unavailable|required)(?:-[a-z]+)*$/i.test(candidate)) {
    return false;
  }
  if (/\d/.test(candidate)) return true;
  if (candidate.length >= 16 && /[._~+/=]/.test(candidate)) return true;
  return candidate.length >= 32;
}

function containsCommonToken(value: string): boolean {
  return /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/i.test(value)
    || /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/i.test(value)
    || /\bglpat-[A-Za-z0-9_-]{20,}\b/i.test(value)
    || /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/i.test(value)
    || /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/i.test(value)
    || /\bAKIA[0-9A-Z]{16}\b/.test(value)
    || /\bAIza[0-9A-Za-z_-]{30,}\b/.test(value)
    || /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(value);
}

function redactSecretAssignments(value: string): string {
  return value
    .replace(
      /(^|[^A-Za-z0-9_])(?:[A-Za-z0-9]+_)*(?:SECRET_ACCESS_KEY|API_KEY|ACCESS_KEY|TOKEN|SECRET|PASSWORD)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\s,;|]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /\b(?:authorization|api[- ]?key|token|secret|password)\s*[:=]\s*(?:bearer\s+)?(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\s,;|]+)/gi,
      "[REDACTED]",
    );
}

function redactBearerCredentials(value: string): string {
  return value.replace(/\bbearer\s+([^\s,;|]+)/gi, (match, candidate: string) => (
    isCredentialLikeBearerValue(candidate) ? "[REDACTED]" : match
  ));
}

function redactLocalHostPaths(value: string): string {
  return value
    .replace(/file:\/\/[^\s,;|\]})>`'"]*/gi, "[LOCAL_PATH]")
    .replace(/(^|[\s"'`\[({=,:])\\\\[^\\/\s,;|\]})>`'"]+[\\/][^\s,;|\]})>`'"]*/g, "$1[LOCAL_PATH]")
    .replace(/(^|[\s"'`\[({=,:])[A-Za-z]:[\\/][^\s,;|\]})>`'"]*/g, "$1[LOCAL_PATH]")
    .replace(
      /(^|[\s"'`\[({=,:])\/(?:Users|tmp|private|root|var\/folders|var\/tmp)(?=\/|[\s,;|\]})>`'"]|$)(?:\/[^\s,;|\]})>`'"]*)?/g,
      "$1[LOCAL_PATH]",
    )
    .replace(/(^|[\s"'`\[({=,:])\/home\/[^/\s,;|\]})>`'"]+(?:\/[^\s,;|\]})>`'"]*)?/g, "$1[LOCAL_PATH]");
}
