import { randomBytes, timingSafeEqual } from "node:crypto";

/** One process-wide token is shared by API modules and regenerated on restart. */
export const securitySessionToken = randomBytes(32).toString("base64url");

export function validSecurityToken(value: string | undefined, expected = securitySessionToken): boolean {
  if (!value || value.length !== expected.length) return false;
  const supplied = Buffer.from(value);
  const target = Buffer.from(expected);
  return supplied.length === target.length && timingSafeEqual(supplied, target);
}
