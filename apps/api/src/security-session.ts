import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { csrfTokenOf } from "./auth/principal.js";

/** One process-wide token is shared by API modules and regenerated on restart. */
export const securitySessionToken = randomBytes(32).toString("base64url");

export function validSecurityToken(value: string | undefined, expected = securitySessionToken): boolean {
  if (!value || value.length !== expected.length) return false;
  const supplied = Buffer.from(value);
  const target = Buffer.from(expected);
  return supplied.length === target.length && timingSafeEqual(supplied, target);
}

/**
 * In server mode the expected token is the one minted with this request's
 * session; in local mode `csrfTokenOf` falls back to the process token, so
 * loopback callers keep the behaviour they had before sessions existed.
 */
export function validRequestCsrf(c: Context): boolean {
  return validSecurityToken(c.req.header("X-CSRF-Token"), csrfTokenOf(c));
}
