import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AgentKind } from './agent-command.js';
import { admitSharedAssets, apparentTreeBytes, releaseReserveOnEnospc, SharedAssetCapacityError } from './shared-asset-capacity.js';

const execFileAsync = promisify(execFile);

/** Rebuildable assets belong to a Workspace, not to an agent or Room. */
export function workspaceAssetRoot(supervisorRoot: string, workspaceId: string): string {
  if (!workspaceId) throw new Error('Workspace id is required for shared assets');
  const digest = createHash('sha256').update(workspaceId).digest('hex').slice(0, 24);
  return resolve(supervisorRoot, 'beeline', 'workspaces', digest, 'shared-home');
}

export interface WorkspaceAssetPaths {
  root: string;
  cache: string;
  tools: string;
  sdk: string;
  avdBase: string;
  staging: string;
}

export const SHARED_LAYOUT_MARKER = 'layout-live-v1.json';

export async function markWorkspaceLayoutLive(paths: WorkspaceAssetPaths): Promise<void> {
  try {
    await writeFile(resolve(paths.root, SHARED_LAYOUT_MARKER), JSON.stringify({ version: 1, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

export function workspaceAssetPaths(root: string): WorkspaceAssetPaths {
  const absolute = resolve(root);
  return {
    root: absolute,
    cache: resolve(absolute, 'cache'),
    tools: resolve(absolute, 'tools'),
    sdk: resolve(absolute, 'sdk'),
    avdBase: resolve(absolute, 'avd-base'),
    staging: resolve(absolute, 'staging'),
  };
}

function supervisorRoot(paths: WorkspaceAssetPaths): string {
  return resolve(paths.root, '../../../..');
}

/** Create only ordinary directories; never follow an attacker-supplied asset symlink. */
export async function prepareWorkspaceAssets(root: string): Promise<WorkspaceAssetPaths> {
  const paths = workspaceAssetPaths(root);
  const chain = [
    resolve(paths.root, '../../..'),
    resolve(paths.root, '../..'),
    resolve(paths.root, '..'),
    paths.root,
    paths.cache,
    resolve(paths.cache, 'codex'),
    resolve(paths.cache, 'codex', 'download'),
    resolve(paths.cache, 'codex', 'plugins'),
    resolve(paths.cache, 'gradle'),
    resolve(paths.cache, 'gradle', 'caches'),
    resolve(paths.cache, 'cargo'),
    resolve(paths.cache, 'cargo', 'registry'),
    paths.tools,
    paths.sdk,
    paths.avdBase,
    paths.staging,
  ];
  for (const path of chain) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path)
      throw new Error(`shared asset path is not an ordinary directory: ${path}`);
  }
  return paths;
}

/** Codex has no separate cache env: exact binds leave CODEX_HOME private. */
export async function prepareCodexCacheTargets(codexHome: string): Promise<void> {
  for (const path of [
    resolve(codexHome, 'cache'),
    resolve(codexHome, 'plugins'),
    resolve(codexHome, 'plugins', 'cache'),
  ]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path)
      throw new Error(`Codex cache mount target is not an ordinary directory: ${path}`);
  }
}

/** Tool settings/credentials stay in private HOME; only download trees are rebound. */
export async function preparePackageCacheTargets(userHome: string): Promise<void> {
  for (const path of [
    resolve(userHome, '.gradle'),
    resolve(userHome, '.gradle/caches'),
    resolve(userHome, '.cargo'),
    resolve(userHome, '.cargo/registry'),
  ]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path)
      throw new Error(`package cache mount target is not an ordinary directory: ${path}`);
  }
}

export function containedAssetPath(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Select only cache-specific variables. HOME/XDG and tool homes that contain
 * credentials or generated configuration remain inside the private Room home.
 */
export function workspaceCacheEnv(paths: WorkspaceAssetPaths, cornerRoot?: string): Record<string, string> {
  const cache = paths.cache;
  return {
    npm_config_cache: resolve(cache, 'npm'),
    PNPM_CONFIG_STORE_DIR: resolve(cache, 'pnpm'),
    PIP_CACHE_DIR: resolve(cache, 'pip'),
    UV_CACHE_DIR: resolve(cache, 'uv'),
    GOMODCACHE: resolve(cache, 'go-mod'),
    GOCACHE: resolve(cache, 'go-build'),
    TURBO_CACHE_DIR: resolve(cache, 'turbo'),
    HUGGINGFACE_HUB_CACHE: resolve(cache, 'huggingface'),
    HF_HUB_CACHE: resolve(cache, 'huggingface'),
    PLAYWRIGHT_BROWSERS_PATH: resolve(cache, 'browser/playwright'),
    PUPPETEER_CACHE_DIR: resolve(cache, 'browser/puppeteer'),
    ...(cornerRoot ? { CARGO_TARGET_DIR: resolve(cornerRoot, '.beeline-cargo-target') } : {}),
  };
}

async function sdkManifestDigest(root: string): Promise<string> {
  const files: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name === 'source.properties' || entry.name === 'package.xml') files.push(path);
    }
  };
  await visit(root);
  files.sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(relative(root, file));
    hash.update(await readFile(file));
  }
  return hash.digest('hex').slice(0, 24);
}

async function processExists(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function withGenerationLock<T>(lock: string, work: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    try {
      await mkdir(lock, { mode: 0o700 });
      await writeFile(resolve(lock, 'pid'), String(process.pid));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = Number(await readFile(resolve(lock, 'pid'), 'utf8').catch(() => ''));
      const age = Date.now() - (await stat(lock)).mtimeMs;
      if (age > 60_000 && (!Number.isSafeInteger(owner) || !(await processExists(owner)))) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error('timed out waiting for Workspace asset generation');
      await new Promise((done) => setTimeout(done, 200));
    }
  }
  try { return await work(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

/** Publish an SDK snapshot, never modifying a generation selected by a child. */
export async function prepareWorkspaceSdk(paths: WorkspaceAssetPaths, sourceSdk: string): Promise<string> {
  const source = await realpath(sourceSdk);
  const digest = await sdkManifestDigest(source);
  const published = resolve(paths.sdk, digest);
  if ((await stat(published).catch(() => undefined))?.isDirectory()) return published;
  if (!(await admitSharedAssets(supervisorRoot(paths), (await apparentTreeBytes(source)) + 1024 ** 3)))
    throw new SharedAssetCapacityError();
  return withGenerationLock(resolve(paths.staging, `sdk-${digest}.lock`), async () => {
    if ((await stat(published).catch(() => undefined))?.isDirectory()) return published;
    const staged = resolve(paths.staging, `sdk-${digest}-${randomUUID()}`);
    try {
      await cp(source, staged, { recursive: true, dereference: false });
      if ((await sdkManifestDigest(source)) !== digest)
        throw new Error('Android SDK changed while publishing a Workspace generation');
      await rename(staged, published);
      return published;
    } catch (error) {
      await releaseReserveOnEnospc(supervisorRoot(paths), error);
      throw error;
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
  });
}

/** AVD metadata is small; mutable userdata never enters this base generation. */
export async function prepareWorkspaceAvdBase(paths: WorkspaceAssetPaths, sourceAvdHome: string): Promise<string> {
  const source = await realpath(sourceAvdHome);
  const entries = (await readdir(source)).filter((entry) => entry.endsWith('.ini')).sort();
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(entry);
    hash.update(await readFile(resolve(source, entry)));
    hash.update(await readFile(resolve(source, entry.slice(0, -4) + '.avd', 'config.ini')).catch(() => ''));
  }
  const digest = hash.digest('hex').slice(0, 24);
  const published = resolve(paths.avdBase, digest);
  if ((await stat(published).catch(() => undefined))?.isDirectory()) return published;
  return withGenerationLock(resolve(paths.staging, `avd-${digest}.lock`), async () => {
    if ((await stat(published).catch(() => undefined))?.isDirectory()) return published;
    const staged = resolve(paths.staging, `avd-${digest}-${randomUUID()}`);
    try {
      await mkdir(staged, { recursive: true, mode: 0o700 });
      for (const entry of entries) {
        const config = resolve(source, entry.slice(0, -4) + '.avd', 'config.ini');
        await cp(resolve(source, entry), resolve(staged, entry));
        if ((await stat(config).catch(() => undefined))?.isFile()) {
          const dest = resolve(staged, entry.slice(0, -4) + '.avd');
          await mkdir(dest);
          await cp(config, resolve(dest, 'config.ini'));
        }
      }
      await rename(staged, published);
      return published;
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
  });
}

const ADAPTER_PACKAGES: Partial<Record<AgentKind, { name: string; binary: string }>> = {
  codex: { name: '@agentclientprotocol/codex-acp', binary: 'codex-acp' },
  claude: { name: '@agentclientprotocol/claude-agent-acp', binary: 'claude-agent-acp' },
  pi: { name: 'pi-acp', binary: 'pi-acp' },
};

/** Pin the selected adapter under this Workspace; published generations are never changed. */
export async function prepareWorkspaceAdapter(
  paths: WorkspaceAssetPaths,
  kind: AgentKind | undefined,
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const adapter = kind && ADAPTER_PACKAGES[kind];
  if (!adapter || basename(command) !== adapter.binary) return command;
  const sourceBinary = isAbsolute(command)
    ? command
    : (await execFileAsync('which', [command], { env })).stdout.trim();
  let parent = dirname(await realpath(sourceBinary));
  let version: string | undefined;
  for (let i = 0; i < 6; i++) {
    const manifest = await readFile(resolve(parent, 'package.json'), 'utf8').catch(() => undefined);
    if (manifest) {
      const parsed = JSON.parse(manifest) as { name?: string; version?: string };
      if (parsed.name === adapter.name) { version = parsed.version; break; }
    }
    parent = dirname(parent);
  }
  if (!version || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version))
    throw new Error(`cannot pin installed ${adapter.binary} adapter version`);
  const key = createHash('sha256').update(`${adapter.name}@${version}:${process.versions.modules}`).digest('hex').slice(0, 16);
  const published = resolve(paths.tools, `${adapter.binary}-${version}-${key}`);
  const publishedBinary = resolve(published, 'node_modules/.bin', adapter.binary);
  if ((await stat(publishedBinary).catch(() => undefined))?.isFile()) return publishedBinary;
  if (!(await admitSharedAssets(supervisorRoot(paths), 512 * 1024 ** 2)))
    throw new SharedAssetCapacityError();
  return withGenerationLock(resolve(paths.staging, `adapter-${key}.lock`), async () => {
    if ((await stat(publishedBinary).catch(() => undefined))?.isFile()) return publishedBinary;
    const staged = resolve(paths.staging, `adapter-${key}-${randomUUID()}`);
    try {
      await mkdir(staged, { recursive: true, mode: 0o700 });
      await execFileAsync('npm', [
        'install', '--prefix', staged, '--no-save', '--no-audit', '--no-fund', `${adapter.name}@${version}`,
      ], { env, timeout: 180_000, maxBuffer: 128 * 1024 });
      const stagedBinary = resolve(staged, 'node_modules/.bin', adapter.binary);
      if (!(await stat(stagedBinary).catch(() => undefined))?.isFile())
        throw new Error(`Workspace adapter install did not produce ${adapter.binary}`);
      await rename(staged, published);
      return publishedBinary;
    } catch (error) {
      await releaseReserveOnEnospc(supervisorRoot(paths), error);
      throw error;
    } finally { await rm(staged, { recursive: true, force: true }); }
  });
}
