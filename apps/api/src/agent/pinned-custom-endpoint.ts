import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import {
  Agent as UndiciAgent,
  type Dispatcher as UndiciDispatcher,
} from "undici";

export interface ResolvedEndpointAddress {
  address: string;
  family: 4 | 6;
}

export interface PinnedCustomEndpointDependencies {
  resolve(hostname: string): Promise<readonly ResolvedEndpointAddress[]>;
  createDispatcher(input: PinnedCustomEndpointDispatcherInput): UndiciDispatcher;
}

export interface PinnedCustomEndpointDispatcherInput {
  hostname: string;
  address: ResolvedEndpointAddress;
}

/** Raised when a custom hostname resolves outside the explicitly permitted network scope. */
export class PinnedCustomEndpointError extends Error {
  constructor() {
    super("custom_endpoint_resolution_blocked");
    this.name = "PinnedCustomEndpointError";
  }
}

/**
 * Resolve once, validate every answer, then force Undici to connect to that
 * exact address while retaining the hostname for HTTP Host and TLS SNI.
 */
export async function createPinnedCustomEndpointDispatcher(
  endpoint: string,
  allowInsecureLocalhost: boolean,
  dependencies: PinnedCustomEndpointDependencies = defaultDependencies,
): Promise<UndiciDispatcher> {
  const url = new URL(endpoint);
  const hostname = normalizedHostname(url.hostname);
  const addresses = await resolveEndpointAddresses(hostname, dependencies);
  if (addresses.length === 0) throw new PinnedCustomEndpointError();
  const explicitLoopbackHostname = isExplicitLoopbackHostname(hostname);

  for (const address of addresses) {
    const scope = addressScope(address.address, address.family);
    if (
      scope === "blocked" ||
      (scope === "loopback" && (!allowInsecureLocalhost || !explicitLoopbackHostname)) ||
      (explicitLoopbackHostname && scope !== "loopback")
    ) {
      throw new PinnedCustomEndpointError();
    }
  }

  return dependencies.createDispatcher({ hostname, address: addresses[0]! });
}

async function resolveEndpointAddresses(
  hostname: string,
  dependencies: PinnedCustomEndpointDependencies,
): Promise<readonly ResolvedEndpointAddress[]> {
  const family = isIP(hostname);
  if (family === 4 || family === 6) return [{ address: hostname, family }];
  try {
    return await dependencies.resolve(hostname);
  } catch {
    throw new PinnedCustomEndpointError();
  }
}

const defaultDependencies: PinnedCustomEndpointDependencies = {
  async resolve(hostname) {
    const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
    return addresses
      .filter((address): address is ResolvedEndpointAddress => address.family === 4 || address.family === 6)
      .map((address) => ({ address: address.address, family: address.family }));
  },
  createDispatcher({ hostname, address }) {
    return new UndiciAgent({
      headersTimeout: 0,
      bodyTimeout: 0,
      connect: {
        // `hostname` remains the URL host, so TLS validates the original name
        // and sends the original SNI. The lookup callback is the sole IP input.
        servername: hostname,
        lookup(requestedHost, options, callback) {
          if (normalizedHostname(requestedHost) !== hostname) {
            callback(new Error("unexpected_pinned_lookup_host"), "", 0);
            return;
          }
          // Node 24 enables autoSelectFamily by default. In that mode it calls
          // custom lookup with `all: true` and requires the dns.lookup-style
          // address array rather than the scalar callback form.
          if (options.all) {
            callback(null, [address]);
            return;
          }
          callback(null, address.address, address.family);
        },
      },
    });
  },
};

type AddressScope = "public" | "loopback" | "blocked";

function addressScope(address: string, family: 4 | 6): AddressScope {
  return family === 4 ? ipv4Scope(address) : ipv6Scope(address);
}

function ipv4Scope(address: string): AddressScope {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return "blocked";
  }
  const [first, second, third] = parts as [number, number, number, number];
  if (first === 127) return "loopback";
  if (
    first === 0 ||
    first === 10 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  ) return "blocked";
  return "public";
}

function ipv6Scope(address: string): AddressScope {
  const value = ipv6Value(address);
  if (value === null) return "blocked";
  if (value === 1n) return "loopback";
  if (value === 0n || !hasPrefix(value, 0x20000000000000000000000000000000n, 3)) return "blocked";
  if (
    hasPrefix(value, 0x20010db80000000000000000000000000n, 32) ||
    hasPrefix(value, 0x20010002000000000000000000000000n, 48)
  ) return "blocked";
  return "public";
}

function hasPrefix(value: bigint, prefix: bigint, length: number): boolean {
  return (value >> BigInt(128 - length)) === (prefix >> BigInt(128 - length));
}

function ipv6Value(address: string): bigint | null {
  const value = address.toLowerCase();
  if (value.includes("%")) return null;
  const [leftRaw, rightRaw, ...extra] = value.split("::");
  if (extra.length > 0) return null;
  const left = leftRaw === "" ? [] : leftRaw.split(":");
  const right = rightRaw === undefined || rightRaw === "" ? [] : rightRaw.split(":");
  if (left.some((part) => !isHexGroup(part)) || right.some((part) => !isHexGroup(part))) return null;
  const omitted = 8 - left.length - right.length;
  if ((rightRaw === undefined && omitted !== 0) || omitted < 0) return null;
  const groups = [...left, ...Array<string>(omitted).fill("0"), ...right];
  if (groups.length !== 8) return null;
  return BigInt(`0x${groups.map((group) => group.padStart(4, "0")).join("")}`);
}

function isHexGroup(value: string): boolean {
  return /^[0-9a-f]{1,4}$/.test(value);
}

function normalizedHostname(value: string): string {
  return value.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
}

function isExplicitLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  const family = isIP(hostname);
  return (family === 4 && ipv4Scope(hostname) === "loopback") ||
    (family === 6 && ipv6Scope(hostname) === "loopback");
}
