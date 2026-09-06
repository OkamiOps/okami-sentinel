import { isIP } from "node:net";

/** The local API has no global client authentication and must not bind publicly. */
export function localApiHost(value: string | undefined): string {
  const host = value?.trim() || "127.0.0.1";
  if (host === "localhost") return "127.0.0.1";
  if (host === "::1" || host === "[::1]") return "::1";
  if (isIP(host) === 4 && host.startsWith("127.")) return host;
  throw new Error("CSB_HOST must be a loopback address. The local API has no global authentication; remote binding is not supported.");
}
