import { constants as fsConstants } from 'node:fs';
import { ordinaryDirectory, removeStoragePath } from './storage-filesystem.js';
import { assertInstallTestIsolation } from './lifecycle-test-guard.js';
import { access, copyFile, lstat, mkdir, readFile, readdir, rename, rm, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseUpdateManifest, resolveManifestUrl, type InstalledBundleIdentity, type PublishedBundle } from './self-update-manifest.js';
import { BeelineInstallLayout, activeReleaseId, BUNDLE_ENTRYPOINT, pathKind, readBundleJson, sanitizeReleaseId, fsyncDir, readUpdateState, writeUpdateState, replaceFile, FORWARDER_TOOLS, FORWARDER_ALIASES, forwarderScript, fetchText, hostPlatformKey, stageRelease } from './self-update.js';



/**
 * Point the live install at `releaseId` with a single atomic rename.
 *
 * The `lib/beeline` symlink is replaced by renaming a freshly-created symlink
 * over it — rename(2) is atomic, so there is no window in which the install
 * is half-replaced. Legacy installs (real directory) are migrated first:
 * the directory moves wholesale into `releases/<legacyId>` (preserving the
 * existing bundle without overwriting its files), then the symlink takes its place. That
 * one-time migration has a millisecond-scale window between the two renames;
 * every subsequent swap is a single rename.
 *
 * Bin entry points are rewritten to stable forwarders into the symlinked
 * bundle, so they never need to change again across releases.
 */
export async function activateRelease(
  layout: BeelineInstallLayout,
  releaseId: string,
  options: { deferPruning?: boolean } = {},
): Promise<void> {
  assertInstallTestIsolation(layout);
  let releaseDir = join(layout.releasesRoot, releaseId);
  let previousReleaseId = await activeReleaseId(layout);
  await access(join(releaseDir, BUNDLE_ENTRYPOINT), fsConstants.F_OK);

  await mkdir(layout.releasesRoot, { recursive: true });
  await mkdir(layout.binDir, { recursive: true });

  const kind = await pathKind(layout.libDir);
  if (kind === 'directory') {
    // Legacy migration. Name the preserved copy after its own identity when
    // it carries one.
    const legacyIdentity = await readBundleJson(layout.libDir);
    const legacyId = sanitizeReleaseId(
      legacyIdentity?.commit ?? legacyIdentity?.version ?? `legacy-${Date.now()}`,
    );
    const legacyDir = join(layout.releasesRoot, legacyId);
    try {
      await access(legacyDir, fsConstants.F_OK);
      // Collision (same id already staged): keep both, suffix this one.
      const preservedId = `${legacyId}-${Date.now()}`;
      await rename(layout.libDir, join(layout.releasesRoot, preservedId));
      await normalizeLegacyBundleShape(join(layout.releasesRoot, preservedId));
      previousReleaseId = preservedId;
    } catch {
      await rename(layout.libDir, legacyDir);
      await normalizeLegacyBundleShape(legacyDir);
      previousReleaseId = legacyId;
    }
  }

  const tempLink = `${layout.libDir}.new-${process.pid}`;
  await rm(tempLink, { force: true });
  await symlink(join('beeline-releases', releaseId), tempLink);
  await rename(tempLink, layout.libDir);
  await fsyncDir(dirname(layout.libDir));

  // Stable forwarders in bin/ — identical across releases, so this is setup,
  // not per-update churn.
  await installRecoveryLauncher(layout, releaseDir);
  await writeBinForwarders(layout, releaseDir);
  const state = await readUpdateState(layout);
  await writeUpdateState(layout, { ...state, stagedReleaseId: undefined,
    previousReleaseId: previousReleaseId && previousReleaseId !== releaseId ? previousReleaseId : state.previousReleaseId });
  if (!options.deferPruning) await pruneHelperReleases(layout);
}


export async function installRecoveryLauncher(
  layout: BeelineInstallLayout,
  releaseDir: string,
): Promise<void> {
  const bootstrap = join(releaseDir, 'lib/beeline/recovery-cli.mjs');
  if (
    await access(bootstrap).then(
      () => true,
      () => false,
    )
  ) {
    const stable = resolve(layout.libDir, '../beeline-bootstrap.mjs');
    const temporary = `${stable}.${process.pid}.tmp`;
    await copyFile(bootstrap, temporary);
    await rename(temporary, stable);
    await replaceFile(
      resolve(layout.libDir, '../beeline-node-path'),
      `${process.execPath}\n`,
      0o600,
    );
  }
}


/** Files a legacy-flat bundle keeps at its root; migration moves them into lib/beeline/. */
export const LEGACY_FLAT_BUNDLE_FILES = [
  'beeline-cli.mjs',
  'beeline-readonly-mcp.mjs',
  'pi-mcp-adapter.mjs',
  'bundle.json',
];


/**
 * A real-directory install preserved from before self-update existed may hold
 * the bundle FLAT (installer v1 wrote beeline-cli.mjs beside bundle.json).
 * Move those files down into lib/beeline/ so the preserved copy is
 * release-shaped so entrypoint resolution and identity reads see one shape. Deliberately tolerant of
 * mid-migration directories that carry files at BOTH levels (a repair
 * reinstall through the anchor symlink can produce exactly that): an inner
 * file always wins, a missing inner file is filled from the root, and
 * anything else at the root is left untouched.
 */
export async function normalizeLegacyBundleShape(bundleDir: string): Promise<void> {
  const innerLib = join(bundleDir, 'lib', 'beeline');
  let anyFlat = false;
  for (const name of LEGACY_FLAT_BUNDLE_FILES) {
    try {
      await access(join(bundleDir, name), fsConstants.F_OK);
      anyFlat = true;
      break;
    } catch {
      // not flat here
    }
  }
  if (!anyFlat) return;
  await mkdir(innerLib, { recursive: true });
  for (const name of LEGACY_FLAT_BUNDLE_FILES) {
    try {
      await access(join(innerLib, name), fsConstants.F_OK);
      continue; // inner copy wins; leave the stray root copy alone
    } catch {
      // fill from the root
    }
    await rename(join(bundleDir, name), join(innerLib, name)).catch(() => undefined);
  }
}


/**
 * Rewrite `<prefix>/bin/*` as stable forwarders into the ACTIVE bundle root
 * (`<prefix>/lib/beeline/bin/<tool>` — through the anchor, never a resolved
 * release path). Used by activation and by repairInstallForwarders.
 */
export async function writeBinForwarders(
  layout: BeelineInstallLayout,
  activeBundleRoot: string,
): Promise<void> {
  const entries: ReadonlyArray<readonly [string, (typeof FORWARDER_TOOLS)[number]]> = [
    ...FORWARDER_TOOLS.map((tool) => [tool, tool] as const),
    ...Object.entries(FORWARDER_ALIASES).map(([alias, tool]) => [alias, tool] as const),
  ];
  for (const [name, tool] of entries) {
    const target = join(activeBundleRoot, 'bin', tool);
    try {
      await access(target, fsConstants.X_OK);
    } catch {
      continue; // bundle does not ship this tool; leave any existing entry alone
    }
    const independent = await access(resolve(layout.libDir, '../beeline-bootstrap.mjs')).then(
      () => true,
      () => false,
    );
    await replaceFile(
      join(layout.binDir, name),
      independent || tool !== 'beeline'
        ? forwarderScript(tool)
        : forwarderScript('legacy-beeline').replace('/bin/legacy-beeline', '/bin/beeline'),
      0o755,
    );
  }
}


/**
 * Heal `<prefix>/bin/*` on installs where a stale or foreign writer left
 * entries that do not follow the anchor contract — most notably installer v1's
 * raw wrappers, whose `pwd -P` resolves the anchor symlink to the release ROOT
 * and execs a path that is not there (the MODULE_NOT_FOUND regression). A
 * daemon that survived the drift can still start (it is launched by node
 * directly, not through the wrapper), so it repairs the shell entries at
 * startup and every later fresh-shell invocation works again. Bin-name
 * aliases (FORWARDER_ALIASES) are healed the same way, so a host installed
 * before an alias existed gains it on the next daemon start without waiting
 * for an update. Only meaningful once the install is release-based (anchor
 * is a symlink); legacy real-dir installs are consistent by construction.
 * Idempotent: a matching forwarder is left untouched.
 */
export async function repairInstallForwarders(
  layout: BeelineInstallLayout,
  opts: { logger?: (line: string) => void } = {},
): Promise<boolean> {
  assertInstallTestIsolation(layout);
  if ((await pathKind(layout.libDir)) !== 'symlink') return false;
  await installRecoveryLauncher(layout, layout.libDir);
  const forwarderHealthy = async (name: string, tool: string): Promise<boolean> => {
    let current: string | undefined;
    try {
      current = await readFile(join(layout.binDir, name), 'utf8');
    } catch {
      current = undefined;
    }
    const independent = await access(resolve(layout.libDir, '../beeline-bootstrap.mjs')).then(
      () => true,
      () => false,
    );
    const expected =
      independent || tool !== 'beeline'
        ? forwarderScript(tool)
        : forwarderScript('legacy-beeline').replace('/bin/legacy-beeline', '/bin/beeline');
    return current === expected;
  };
  let healthy = await forwarderHealthy('beeline', 'beeline');
  for (const [alias, tool] of Object.entries(FORWARDER_ALIASES)) {
    if (!(await forwarderHealthy(alias, tool))) healthy = false;
  }
  if (healthy) return false;
  await mkdir(layout.binDir, { recursive: true });
  // The anchor itself is the active bundle root; access() follows the symlink.
  await writeBinForwarders(layout, layout.libDir);
  opts.logger?.(
    `[body] self-update: repaired <prefix>/bin forwarders to follow the active-bundle anchor (${layout.libDir})`,
  );
  return true;
}


// ---------------------------------------------------------------------------
// Compatibility entry for one explicit preparation
// ---------------------------------------------------------------------------

export interface SelfUpdateManagerOptions {
  layout: BeelineInstallLayout;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  fetchImpl?: typeof fetch;
  logger?: (line: string) => void;
  /** Download, verify, and smoke-test only. The serving daemon activates after it proves idle. */
  stageOnly?: boolean;
}


export function describeIdentity(identity: InstalledBundleIdentity | undefined): string {
  if (!identity) return 'unknown';
  const parts: string[] = [];
  if (identity.version) parts.push(identity.version);
  if (identity.commit) parts.push(identity.commit.slice(0, 12));
  return parts.join(' ') || 'unknown';
}


export async function prepareLatestRelease(
  layout: BeelineInstallLayout,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    logger?: (line: string) => void;
    force?: boolean;
    deadlineAt?: number;
    manifest?: { url: string; bundle: PublishedBundle };
  } = {},
): Promise<{ releaseId: string; identity: InstalledBundleIdentity }> {
  try {
    const manifestUrl = options.manifest?.url ?? resolveManifestUrl(options.env ?? process.env);
    const bundle =
      options.manifest?.bundle ??
      parseUpdateManifest(
        await fetchText(manifestUrl, options.fetchImpl ?? fetch),
        hostPlatformKey(),
      ).bundle;
    const pending = (await readUpdateState(layout)).stagedReleaseId;
    const pendingDigest = pending
      ? await readFile(join(layout.releasesRoot, pending, '.stage-ok'), 'utf8').catch(() => '')
      : '';
    const releaseId =
      !options.force && pending && pendingDigest.trim() === bundle.sha256
        ? pending
        : await stageRelease(layout, manifestUrl, bundle, {
            fetchImpl: options.fetchImpl,
            logger: options.logger,
            force: options.force,
            deadlineAt: options.deadlineAt,
          });
    await writeUpdateState(layout, {
      ...(await readUpdateState(layout)),
      lastCheckAt: Date.now(),
      lastCheckResult: 'verified',
      stagedReleaseId: releaseId,
    });
    return { releaseId, identity: { version: bundle.version, commit: bundle.commit } };
  } catch (error) {
    await writeUpdateState(layout, {
      ...(await readUpdateState(layout)),
      lastCheckAt: Date.now(),
      lastCheckResult: 'unconfirmed',
      lastCheckError: String(error),
    }).catch(() => undefined);
    throw error;
  }
}


/** Caller holds the install lock. Startup also repairs installations predating
 * rollback metadata. Only current + previous are durable; a staged update and
 * a still-loaded predecessor remain protected during the handoff. */
export async function pruneHelperReleases(layout: BeelineInstallLayout, loadedRelease?: string): Promise<string[]> {
  assertInstallTestIsolation(layout);
  if (!await ordinaryDirectory(layout.releasesRoot)) return [];
  const active = await activeReleaseId(layout);
  if (!active) return [];
  const state = await readUpdateState(layout);
  const candidates = [];
  for (const entry of await readdir(layout.releasesRoot, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isSymbolicLink()) {
      // Unlink historical install litter without following its target.
      if (![active, state.previousReleaseId, state.stagedReleaseId, loadedRelease].includes(entry.name))
        await rm(join(layout.releasesRoot, entry.name), { force: true });
      continue;
    }
    if (!entry.isDirectory()) continue;
    const path = join(layout.releasesRoot, entry.name);
    if (!await ordinaryDirectory(path)) continue;
    candidates.push({ id: entry.name, modified: (await lstat(path)).mtimeMs,
      bootable: await access(join(path, BUNDLE_ENTRYPOINT)).then(() => true, () => false) });
  }
  const recordedPrevious = candidates.find(entry => entry.id === state.previousReleaseId && entry.id !== active && entry.bootable)?.id;
  const previous = recordedPrevious ?? candidates.filter(entry => entry.bootable && entry.id !== active && entry.id !== state.stagedReleaseId)
    .sort((a, b) => b.modified - a.modified)[0]?.id;
  const keep = new Set([active, previous, loadedRelease, state.stagedReleaseId]);
  const removed: string[] = [];
  for (const entry of candidates) {
    if (keep.has(entry.id)) continue;
    await removeStoragePath(join(layout.releasesRoot, entry.id));
    removed.push(entry.id);
  }
  if (previous !== state.previousReleaseId) await writeUpdateState(layout, { ...state, previousReleaseId: previous });
  return removed;
}
