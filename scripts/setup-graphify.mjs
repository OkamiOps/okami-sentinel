// Sentinel owns this isolated runtime; never installs into a user's Python/PATH.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const version = '0.9.51';
const uvVersion = '0.12.7';
const targets = {
  'darwin-arm64': ['aarch64-apple-darwin', '127ebdda7ad953cdf198e964b570ea5771b85467ea93eb7cb6d6f8e6f55408f3'],
  'darwin-x64': ['x86_64-apple-darwin', '06b8ae1da8c2661c5434507a66f8c2b0b835933bf955b5958a9ac357a37d1959'],
  'linux-arm64': ['aarch64-unknown-linux-gnu', '66393193038dd7eb108abd7a218d9cec04ac70ab98242b0720fa94de19223b7c'],
  'linux-x64': ['x86_64-unknown-linux-gnu', '788f18abea7c5f55d6216e4f5613fd89d4d59b631efeec117b2b07fe72f1da21'],
};
const root = path.resolve(process.env.CSB_GRAPHIFY_INSTALL_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '../.sentinel-tools/graphify'));
const python = path.join(root, 'venv/bin/python');
const executable = path.join(root, 'venv/bin/graphify');
const env = { ...process.env, UV_PYTHON_INSTALL_DIR: path.join(root, 'python'), UV_CACHE_DIR: path.join(root, 'cache'), UV_PYTHON_PREFERENCE: 'only-managed', UV_PYTHON_DOWNLOADS: 'automatic' };
function run(bin, args, options = {}) {
  const result = spawnSync(bin, args, { env, stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(bin)} ${args[0]} failed: ${result.error?.message || result.status}`);
  return result;
}
function installed() {
  if (!existsSync(executable)) return false;
  const result = spawnSync(python, ['-c', 'import importlib.metadata; print(importlib.metadata.version("graphifyy"))'], { encoding: 'utf8', env });
  return result.status === 0 && result.stdout.trim() === version;
}
async function main() {
  if (process.env.CSB_SKIP_GRAPHIFY_SETUP === '1') return;
  if (installed()) { console.log(`Sentinel Graphify ${version} ready: ${executable}`); return; }
  const target = targets[`${process.platform}-${process.arch}`];
  if (!target) throw new Error('Managed Graphify supports macOS and glibc Linux x64/arm64. Use the Docker installation on other platforms.');
  mkdirSync(root, { recursive: true });
  const staging = mkdtempSync(path.join(tmpdir(), 'sentinel-graphify-'));
  try {
    const archiveName = `uv-${target[0]}.tar.gz`;
    const response = await fetch(`https://github.com/astral-sh/uv/releases/download/${uvVersion}/${archiveName}`, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`uv download failed (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== target[1]) throw new Error('uv archive checksum mismatch');
    const archive = path.join(staging, archiveName);
    writeFileSync(archive, bytes);
    run('tar', ['-xzf', archive, '-C', staging]);
    const uv = path.join(staging, `uv-${target[0]}`, 'uv');
    // Python is downloaded into the managed root, not taken from the host.
    if (!existsSync(python)) run(uv, ['--no-config', 'venv', '--python', '3.12', path.join(root, 'venv')]);
    run(uv, ['--no-config', 'pip', 'install', '--python', python, `graphifyy==${version}`]);
    run(executable, ['--version']);
    if (!installed()) throw new Error('Graphify version verification failed');
    writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify({ package: 'graphifyy', version, uvVersion, python: '3.12' }, null, 2)}\n`);
    console.log(`Sentinel Graphify ${version} ready: ${executable}`);
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
main().catch(error => { console.error(`Graphify setup: ${error.message}. Retry with pnpm setup:graphify.`); process.exitCode = 1; });
