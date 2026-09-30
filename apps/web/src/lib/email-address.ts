/**
 * The same address rule the API applies, repeated on the screen only to
 * *predict* it: the invite dialog has to say whether a message will be sent
 * before the request exists, and Minha conta explains a missing address.
 *
 * The pattern is deliberately identical to `isEmailAddress` in
 * `apps/api/src/email/address.ts`, including the 254-character cap. A looser
 * rule here is not harmless: the dialog would promise "the invitation will be
 * e-mailed to a@b.c" and the reply would then say it was skipped for
 * `no_address` — two contradictory sentences about the same invitation. Any
 * change to the server's rule belongs here in the same commit.
 */
const ADDRESS = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

export function looksLikeEmailAddress(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length <= 254 && ADDRESS.test(trimmed);
}

/**
 * Where an invitation would go: the address typed in the dialog, or the
 * username when that is itself an address. `null` means the invitation has no
 * destination and the link is the only way to deliver it.
 */
export function inviteEmailTarget(email: string, username: string): string | null {
  const typed = email.trim();
  // A filled field is the answer whether or not it parses: the username is the
  // fallback for an *empty* field, and promising delivery to a handle while an
  // unusable address sits in the e-mail box would describe a different invite
  // from the one the server is about to refuse.
  if (typed) return looksLikeEmailAddress(typed) ? typed : null;
  const handle = username.trim();
  return looksLikeEmailAddress(handle) ? handle : null;
}
