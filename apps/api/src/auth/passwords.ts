import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const N = 32768;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { N: n, r, p, maxmem: MAX_MEMORY }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

let dummyHash: Promise<string> | null = null;

// Unknown users and users without a password still pay for one derivation, so
// response time does not reveal which usernames exist.
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const parsed = stored === null ? null : parseHash(stored);
  if (parsed === null) {
    dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
    const dummy = parseHash(await dummyHash)!;
    await derive(password, dummy.salt, dummy.n, dummy.r, dummy.p);
    return false;
  }
  const key = await derive(password, parsed.salt, parsed.n, parsed.r, parsed.p);
  return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
}

function parseHash(stored: string): { n: number; r: number; p: number; salt: Buffer; key: Buffer } | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (n !== N || r !== R || p !== P) return null;
  const salt = Buffer.from(parts[4]!, "base64");
  const key = Buffer.from(parts[5]!, "base64");
  if (salt.length !== 16 || key.length !== KEY_LENGTH) return null;
  return { n, r, p, salt, key };
}

export function passwordPolicyError(
  password: string,
  username: string,
): "password_too_short" | "password_too_long" | "password_matches_username" | null {
  if (password.length < 12) return "password_too_short";
  if (password.length > 256) return "password_too_long";
  if (password.trim().toLowerCase() === username.trim().toLowerCase()) return "password_matches_username";
  return null;
}
