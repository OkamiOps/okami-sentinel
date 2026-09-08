import fs from "node:fs";
import path from "node:path";

export function runtimeMode(env: NodeJS.ProcessEnv = process.env): "local" | "server" {
  const mode = env.CSB_RUNTIME_MODE?.trim() || "local";
  if (mode !== "local" && mode !== "server") throw new Error("CSB_RUNTIME_MODE must be local or server.");
  return mode;
}

export function publicOrigin(env: NodeJS.ProcessEnv = process.env): string {
  let url: URL;
  try { url = new URL(env.CSB_PUBLIC_ORIGIN ?? ""); }
  catch { throw new Error("CSB_PUBLIC_ORIGIN must be an explicit origin."); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("CSB_PUBLIC_ORIGIN must use HTTPS (HTTP is allowed only on loopback), with no path or credentials.");
  }
  return url.origin;
}

export function repositoryRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  if (runtimeMode(env) === "local") return [];
  const roots = (env.CSB_REPOSITORY_ROOTS || "/repos").split(path.delimiter).map((root) => root.trim()).filter(Boolean);
  if (!roots.length || roots.some((root) => !path.isAbsolute(root) || path.parse(root).root === path.resolve(root))) {
    throw new Error("CSB_REPOSITORY_ROOTS must contain restricted absolute directories.");
  }
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

export interface ServerSettings {
  mode: "local" | "server";
  origin: string | null;
  username: string;
  password: string;
  repositoryRoots: string[];
}

/** Only the HTTP entrypoint loads the admin credential; scanner workers do not. */
export function loadServerSettings(env: NodeJS.ProcessEnv = process.env): ServerSettings {
  if (runtimeMode(env) === "local") return { mode: "local", origin: null, username: "", password: "", repositoryRoots: [] };
  const origin = publicOrigin(env);
  const username = env.CSB_ADMIN_USER?.trim() || "admin";
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(username)) throw new Error("CSB_ADMIN_USER is invalid.");
  let password: string;
  try {
    const file = env.CSB_ADMIN_PASSWORD_FILE;
    if (!file || !path.isAbsolute(file)) throw new Error();
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 4096) throw new Error();
    password = fs.readFileSync(file, "utf8").trim();
    if (password.length < 24 || /[\x00-\x1f\x7f]/.test(password)) throw new Error();
    const key = env.CSB_VAULT_KEY_FILE;
    if (!key || !path.isAbsolute(key) || !fs.statSync(key).isFile()) throw new Error();
  } catch { throw new Error("Server mode requires readable admin password (24+ characters) and vault key files."); }
  return { mode: "server", origin, username, password, repositoryRoots: repositoryRoots(env) };
}
