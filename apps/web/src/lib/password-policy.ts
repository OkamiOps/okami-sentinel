/**
 * The client-side half of the server's password policy. It exists so the
 * invite screen and the account screen reject the same passwords for the same
 * reasons; each caller maps the returned issue onto its own wording, since
 * "your new password" and "your password" are different sentences.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

export type PasswordIssue = "tooShort" | "tooLong" | "matchesUsername" | "mismatch";

export function passwordIssue(password: string, confirmation: string, username: string): PasswordIssue | null {
  if (password.length < PASSWORD_MIN_LENGTH) return "tooShort";
  if (password.length > PASSWORD_MAX_LENGTH) return "tooLong";
  if (password.toLowerCase() === username.toLowerCase()) return "matchesUsername";
  if (password !== confirmation) return "mismatch";
  return null;
}
