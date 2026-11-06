import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isSharedAssetCategory, type SharedAssetCategory } from '@beeline/api-contract/agent-grants';


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
}

export const SHARED_LAYOUT_MARKER = 'layout-live-v1.json';
export const PACKAGE_CACHE_DIRS = [
  'npm', 'pnpm', 'uv', 'go-mod', 'go-build', 'turbo', 'huggingface',
  'browser/playwright', 'browser/puppeteer', 'cargo/registry',
] as const;

/** The grant list is the server's live authority, including revocations. */
export function isolatedSharedAssetCategories(grants: {
  grants: readonly { kind: string; target: string; status: string }[];
}): SharedAssetCategory[] {
  return [...new Set(grants.grants
    .filter((grant) => grant.kind === 'shared_asset' && grant.status === 'approved' &&
      isSharedAssetCategory(grant.target))
    .map((grant) => grant.target as SharedAssetCategory))];
}

/** Private trees are stable across this agent's Rooms and are never seeded from shared bytes. */
export async function preparePrivateAssets(root: string, categories: readonly SharedAssetCategory[]): Promise<void> {
  const paths = [root];
  if (categories.includes('package-cache'))
    paths.push(...PACKAGE_CACHE_DIRS.map((suffix) => resolve(root, 'cache', suffix)));
  if (categories.includes('codex-download-cache')) paths.push(resolve(root, 'cache/codex/download'));
  if (categories.includes('codex-plugin-cache')) paths.push(resolve(root, 'cache/codex/plugins'));
  for (const path of paths) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    let cursor = path;
    while (cursor.startsWith(resolve(root)) && cursor !== dirname(resolve(root))) {
      const info = await lstat(cursor);
      if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(cursor)) !== cursor)
        throw new Error(`private asset path is not an ordinary directory: ${cursor}`);
      if (cursor === resolve(root)) break;
      cursor = dirname(cursor);
    }
  }
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
  };
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
    ...PACKAGE_CACHE_DIRS.map((suffix) => resolve(paths.cache, suffix)),
    paths.tools,
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

/**
 * Select only cache-specific variables. HOME/XDG and tool homes that contain
 * credentials or generated configuration remain inside the private Room home.
 */
export function workspaceCacheEnv(paths: WorkspaceAssetPaths, cornerRoot?: string, privateRoot?: string): Record<string, string> {
  const cache = privateRoot ? resolve(privateRoot, 'cache') : paths.cache;
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
