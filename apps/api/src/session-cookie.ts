import type { CookieOptions } from "hono/utils/cookie";
import type { ServerSettings } from "./deployment-settings.js";

/**
 * `__Host-` keeps the cookie pinned to this exact origin: no subdomain can set
 * or read it, and it is only ever sent over HTTPS from the registrable path.
 * The prefix is only honoured together with `Secure`, though, and a browser
 * never sends a `Secure` cookie back over plain http — which would leave the
 * documented `http://127.0.0.1:8787` installation able to sign in once and then
 * forget the session on the very next request.
 *
 * `CSB_PUBLIC_ORIGIN` already refuses http anywhere but loopback, so the
 * unprefixed name is reachable only where the connection never leaves the host.
 * Both shapes live here so the writer (`auth-api`) and the reader
 * (`server-security`) cannot drift apart, and so a cookie written under the
 * loopback shape can never authenticate an https deployment.
 */
export const SECURE_SESSION_COOKIE = "__Host-sentinel_session";
export const LOOPBACK_SESSION_COOKIE = "sentinel_session";

type OriginSettings = Pick<ServerSettings, "origin">;

function secureOrigin(settings: OriginSettings): boolean {
  return !settings.origin?.startsWith("http://");
}

export function sessionCookieName(settings: OriginSettings): string {
  return secureOrigin(settings) ? SECURE_SESSION_COOKIE : LOOPBACK_SESSION_COOKIE;
}

/** `path: "/"` and no `domain` are what the `__Host-` prefix demands; `maxAge`
 * matches the session's own absolute lifetime, so the browser drops a cookie the
 * server would refuse anyway. */
export function sessionCookieOptions(settings: OriginSettings): CookieOptions {
  return { httpOnly: true, secure: secureOrigin(settings), sameSite: "Lax", path: "/", maxAge: 7 * 24 * 3600 };
}

/** A delete has to repeat the attributes that identify the cookie, or the
 * browser keeps the original one alongside the expired copy. */
export function sessionCookieDeleteOptions(settings: OriginSettings): CookieOptions {
  return { path: "/", secure: secureOrigin(settings) };
}
