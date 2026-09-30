/**
 * The same address resolution the API performs, repeated on the screen only to
 * *predict* it: the invite dialog has to say whether a message will be sent
 * before the request exists, and Minha conta explains a missing address.
 *
 * Deliberately strict and deliberately not a full RFC 5322 parser: one
 * `local@domain` pair, a dot in the domain, no list separators and no control
 * characters. The API's `isEmailAddress` is the authority; a disagreement here
 * can only ever make the screen predict "no e-mail" for an address the server
 * would accept, which is a wrong prediction and never a wrong delivery.
 */
const ADDRESS = /^[^\s@,;<>"\\]+@[^\s@,;<>"\\.]+(?:\.[^\s@,;<>"\\.]+)+$/;

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
