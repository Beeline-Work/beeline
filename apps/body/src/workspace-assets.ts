import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
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

export function sharedAssetsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BEELINE_SHARED_ASSETS_ENABLED !== '0';
}

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

/** Final tool-home selection: inherited machine homes must not cross Workspaces. */
export function workspaceToolEnv(
  env: Record<string, string>,
  home: string,
  paths: WorkspaceAssetPaths,
  cornerRoot?: string,
): Record<string, string> {
  const result = { ...env };
  for (const name of [
    'MAVEN_OPTS', 'MAVEN_ARGS', 'MAVEN_CONFIG', 'MAVEN_USER_HOME', 'MAVEN_REPO_LOCAL',
    'GRADLE_OPTS', 'GRADLE_RO_DEP_CACHE', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'JAVA_HOME',
    'NODE_PATH', 'PIP_CONFIG_FILE', 'PIP_TARGET', 'PIP_PREFIX', 'PIP_USER',
    'ANDROID_NDK_HOME', 'ANDROID_NDK_ROOT', 'ANDROID_SDK_HOME',
    'NVM_BIN', 'NVM_INC', 'FNM_MULTISHELL_PATH', 'RUSTUP_TOOLCHAIN', 'ASDF_DIR',
    'PYENV_VERSION', 'RBENV_VERSION', 'SDKMAN_DIR',
  ]) delete result[name];
  Object.assign(result, workspaceCacheEnv(paths, cornerRoot), {
    PIP_CACHE_DIR: resolve(home, '.cache/pip'),
    GRADLE_USER_HOME: resolve(home, '.gradle'),
    CARGO_HOME: resolve(home, '.cargo'),
    CARGO_INSTALL_ROOT: resolve(home, '.cargo'),
    RUSTUP_HOME: resolve(home, '.rustup'),
    GOPATH: resolve(home, 'go'),
    GOBIN: resolve(home, 'go/bin'),
    GOENV: resolve(home, '.config/go/env'),
    NVM_DIR: resolve(home, '.nvm'),
    FNM_DIR: resolve(home, '.fnm'),
    VOLTA_HOME: resolve(home, '.volta'),
    ASDF_DATA_DIR: resolve(home, '.asdf'),
    MISE_DATA_DIR: resolve(home, '.local/share/mise'),
    PYENV_ROOT: resolve(home, '.pyenv'),
    RBENV_ROOT: resolve(home, '.rbenv'),
    PNPM_HOME: resolve(home, '.local/share/pnpm'),
    COREPACK_HOME: resolve(home, '.cache/node/corepack'),
    npm_config_prefix: resolve(home, '.local'),
    NPM_CONFIG_PREFIX: resolve(home, '.local'),
  });
  return result;
}

async function sdkTreeDigest(root: string): Promise<string> {
  const hash = createHash('sha256');
  const visit = async (dir: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(dir, entry.name);
      const info = await lstat(path);
      hash.update(`${relative(root, path)}\0${info.mode & 0o777}\0`);
      if (info.isDirectory()) {
        hash.update('dir\0');
        await visit(path);
      } else if (info.isFile()) {
        hash.update(`file\0${info.size}\0`);
        for await (const chunk of createReadStream(path)) hash.update(chunk);
        hash.update('\0');
      } else if (info.isSymbolicLink()) {
        const target = await readlink(path);
        if (isAbsolute(target) || !containedAssetPath(root, resolve(dirname(path), target)) ||
            !containedAssetPath(root, await realpath(path)))
          throw new Error(`Android SDK symlink escapes its source: ${path}`);
        hash.update(`symlink\0${target.length}\0${target}\0`);
      } else throw new Error(`unsupported Android SDK entry: ${path}`);
    }
  };
  await visit(root);
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
  const digest = await sdkTreeDigest(source);
  const published = resolve(paths.sdk, digest);
  const publishedValid = async (): Promise<boolean> => {
    const info = await lstat(published).catch(() => undefined);
    if (!info?.isDirectory() || info.isSymbolicLink()) return false;
    return sdkTreeDigest(published).then((actual) => actual === digest, () => false);
  };
  if (await publishedValid()) return published;
  if (!(await admitSharedAssets(supervisorRoot(paths), (await apparentTreeBytes(source)) + 1024 ** 3)))
    throw new SharedAssetCapacityError();
  return withGenerationLock(resolve(paths.staging, `sdk-${digest}.lock`), async () => {
    if (await publishedValid()) return published;
    if (await lstat(published).catch(() => undefined)) {
      await rename(published, resolve(paths.staging, `corrupt-sdk-${digest}-${randomUUID()}`));
    }
    const staged = resolve(paths.staging, `sdk-${digest}-${randomUUID()}`);
    try {
      await cp(source, staged, { recursive: true, dereference: false });
      if ((await sdkTreeDigest(staged)) !== digest || (await sdkTreeDigest(source)) !== digest)
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

const CLI_PACKAGES: Partial<Record<AgentKind, readonly string[]>> = {
  codex: ['@openai/codex'],
  claude: ['@anthropic-ai/claude-code'],
  pi: ['@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent'],
};

async function installedPackage(binary: string, env: NodeJS.ProcessEnv): Promise<{ name: string; version: string } | undefined> {
  const executable = isAbsolute(binary) ? binary : (await execFileAsync('which', [binary], { env })).stdout.trim();
  let parent = dirname(await realpath(executable));
  for (let i = 0; i < 7; i++) {
    const manifest = await readFile(resolve(parent, 'package.json'), 'utf8').catch(() => undefined);
    if (manifest) {
      const parsed = JSON.parse(manifest) as { name?: string; version?: string };
      if (parsed.name && parsed.version && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(parsed.version))
        return { name: parsed.name, version: parsed.version };
    }
    parent = dirname(parent);
  }
  return undefined;
}

export interface WorkspaceToolchain { command: string; binDir: string; cliCommand: string }

/** Pin the selected adapter under this Workspace; published generations are never changed. */
export async function prepareWorkspaceAdapter(
  paths: WorkspaceAssetPaths,
  kind: AgentKind | undefined,
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<WorkspaceToolchain | undefined> {
  const adapter = kind && ADAPTER_PACKAGES[kind];
  // An unknown or native harness remains on its legacy private layout. No
  // selected shared generation may invoke a mutable machine-global child CLI.
  if (!adapter || !kind || basename(command) !== adapter.binary) return undefined;
  const selectedAdapter = await installedPackage(command, env).catch(() => undefined);
  const selectedCli = await installedPackage(kind, env).catch(() => undefined);
  if (selectedAdapter?.name !== adapter.name || !selectedCli ||
      !CLI_PACKAGES[kind]?.includes(selectedCli.name)) return undefined;
  const key = createHash('sha256').update(
    `${adapter.name}@${selectedAdapter.version}:${selectedCli.name}@${selectedCli.version}:${process.version}`,
  ).digest('hex').slice(0, 16);
  const published = resolve(paths.tools, `${adapter.binary}-${selectedAdapter.version}-${key}`);
  const publishedBinary = resolve(published, 'node_modules/.bin', adapter.binary);
  const publishedCli = resolve(published, 'node_modules/.bin', kind);
  const publishedNode = resolve(published, 'bin/node');
  const selection = { command: publishedBinary, binDir: resolve(published, 'node_modules/.bin'), cliCommand: publishedCli };
  if ((await stat(publishedBinary).catch(() => undefined))?.isFile() &&
      (await stat(publishedCli).catch(() => undefined))?.isFile() &&
      (await stat(publishedNode).catch(() => undefined))?.isFile()) return selection;
  if (!(await admitSharedAssets(supervisorRoot(paths), 512 * 1024 ** 2)))
    throw new SharedAssetCapacityError();
  return withGenerationLock(resolve(paths.staging, `adapter-${key}.lock`), async () => {
    if ((await stat(publishedBinary).catch(() => undefined))?.isFile() &&
        (await stat(publishedCli).catch(() => undefined))?.isFile() &&
        (await stat(publishedNode).catch(() => undefined))?.isFile()) return selection;
    const staged = resolve(paths.staging, `adapter-${key}-${randomUUID()}`);
    try {
      await mkdir(staged, { recursive: true, mode: 0o700 });
      await execFileAsync('npm', [
        'install', '--prefix', staged, '--no-save', '--no-audit', '--no-fund',
        `${adapter.name}@${selectedAdapter.version}`, `${selectedCli.name}@${selectedCli.version}`,
      ], { env, timeout: 180_000, maxBuffer: 128 * 1024 });
      const stagedBinary = resolve(staged, 'node_modules/.bin', adapter.binary);
      if (!(await stat(stagedBinary).catch(() => undefined))?.isFile() ||
          !(await stat(resolve(staged, 'node_modules/.bin', kind)).catch(() => undefined))?.isFile())
        throw new Error(`Workspace toolchain install did not produce ${adapter.binary} and ${kind}`);
      await mkdir(resolve(staged, 'bin'));
      await cp(process.execPath, resolve(staged, 'bin/node'));
      await rename(staged, published);
      return selection;
    } catch (error) {
      await releaseReserveOnEnospc(supervisorRoot(paths), error);
      throw error;
    } finally { await rm(staged, { recursive: true, force: true }); }
  });
}
