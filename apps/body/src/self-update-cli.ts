/**
 * `beeline update` — the on-demand half of the daemon self-update path.
 *
 * Applies the published bundle to the local install (download, sha256
 * verify, atomic swap) and, for every daemon currently running, leaves an
 * update request the daemon consumes within one tick — the daemon then
 * restarts onto the new bundle through its own busy gate, so an operator can
 * never interrupt agent work by updating.
 */
import pc from 'picocolors';
import {
  findAgentRuntimeConfigPaths,
  findRuntimeConfigPaths,
  readRuntimeRecord,
  resolveRuntimeConfigPath,
  runtimeDaemonPid,
} from './runtime.js';
import {
  SelfUpdateManager,
  activeReleaseId,
  archiveUrlFor,
  beelineInstallLayout,
  describeIdentity,
  hostPlatformKey,
  queueRestartRequest,
  readInstalledBundleIdentity,
  readPendingUpdate,
  readUpdateState,
  rollbackToPreviousRelease,
  type BeelineInstallLayout,
} from './self-update.js';
import {
  compareBundleIdentity,
  parseUpdateManifest,
  resolveManifestUrl,
} from './self-update-manifest.js';

function updateUsage(): void {
  console.log(`
${pc.bold('Update the installed Beeline bundle from the published manifest.')}

${pc.dim('Usage:')}
  beeline update                     Check, download, verify, and apply;
                                     running daemons restart onto it once idle
  beeline update --check             Report only — no download, no swap
  beeline update --status            Show installed identity, releases, and state
  beeline update --rollback          Restore the previous release (queued restart)
  beeline update --force             Apply even when the comparison is indeterminate
  beeline update --manifest-url <u>  Override the published manifest URL

The daemon also checks automatically (every BEELINE_UPDATE_INTERVAL_MS,
default 6h) with the same busy gate; BEELINE_UPDATE_DISABLE=1 turns the
automatic path off. \`beeline update\` always works.
`);
}

function requireLayout(): BeelineInstallLayout {
  const layout = beelineInstallLayout(process.env);
  if (!layout) {
    throw new Error(
      'beeline update needs a bundle install (the installer layout). ' +
        'This command was started outside the bundled `beeline` wrapper; update a dev checkout with git instead.',
    );
  }
  return layout;
}

async function runningDaemonConfigPaths(): Promise<string[]> {
  const cwd = process.cwd();
  const [repoConfigs, hostConfigs] = await Promise.all([
    findRuntimeConfigPaths(cwd).catch(() => [] as string[]),
    findAgentRuntimeConfigPaths(process.env, cwd).catch(() => [] as string[]),
  ]);
  const running: string[] = [];
  for (const configPath of [...new Set([...repoConfigs, ...hostConfigs])]) {
    const resolved = await resolveRuntimeConfigPath(configPath).catch(() => undefined);
    if (!resolved) continue;
    if (await runtimeDaemonPid(resolved)) running.push(resolved);
  }
  return running;
}

async function printStatus(layout: BeelineInstallLayout): Promise<void> {
  const installed = await readInstalledBundleIdentity(layout);
  const active = await activeReleaseId(layout);
  const state = await readUpdateState(layout);
  const pending = await readPendingUpdate(layout);
  console.log(`${pc.bold('installed bundle')}  ${describeIdentity(installed)}`);
  console.log(`${pc.bold('active release')}    ${active ?? 'none (legacy layout, never updated)'}`);
  if (state.lastCheckAt) {
    console.log(
      `${pc.bold('last check')}         ${new Date(state.lastCheckAt).toISOString()} — ${state.lastCheckResult ?? 'unknown'}`,
    );
  }
  if (state.lastApplied) {
    console.log(
      `${pc.bold('last applied')}       ${describeIdentity(state.lastApplied.identity)} at ${new Date(state.lastApplied.at).toISOString()} (previous: ${state.lastApplied.previousReleaseId ?? 'none'})`,
    );
  }
  if (state.lastRollback) {
    console.log(
      `${pc.bold('last rollback')}      ${state.lastRollback.releaseId} -> ${state.lastRollback.toReleaseId} (${state.lastRollback.reason})`,
    );
  }
  if (pending) {
    console.log(
      `${pc.bold('pending update')}     -> ${describeIdentity(pending.to)}, applied ${new Date(pending.appliedAt).toISOString()}, awaiting health confirmation`,
    );
  }
}

async function queueRestartOnRunningDaemons(): Promise<number> {
  const running = await runningDaemonConfigPaths();
  for (const configPath of running) {
    const runtime = await readRuntimeRecord(configPath).catch(() => undefined);
    await queueRestartRequest(configPath);
    console.log(
      `[beeline] daemon ${runtime?.agent.publicKey?.slice(0, 12) ?? configPath} is running; ` +
        'it will restart onto the new bundle once its current work finishes (never mid-turn).',
    );
  }
  return running.length;
}

export async function runUpdateCommand(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    updateUsage();
    return;
  }

  const layout = requireLayout();
  const manifestUrlFlag = args.indexOf('--manifest-url');
  const manifestUrl = manifestUrlFlag >= 0 && args[manifestUrlFlag + 1]
    ? args[manifestUrlFlag + 1]!
    : resolveManifestUrl(process.env);
  const checkOnly = args.includes('--check');
  const force = args.includes('--force');
  const rollback = args.includes('--rollback');

  if (rollback) {
    const state = await readUpdateState(layout);
    const previous = state.lastApplied?.previousReleaseId;
    if (!previous) throw new Error('no previous release recorded to roll back to');
    await rollbackToPreviousRelease(layout, previous);
    console.log(`[beeline] rolled back to release ${previous}.`);
    const running = await queueRestartOnRunningDaemons();
    console.log(
      running > 0
        ? '[beeline] running daemons will restart onto it once idle.'
        : '[beeline] no running daemon; the rollback takes effect on the next `beeline start`.',
    );
    return;
  }

  if (args.includes('--status')) {
    await printStatus(layout);
    return;
  }

  const installed = await readInstalledBundleIdentity(layout);
  console.log(`[beeline] installed bundle: ${describeIdentity(installed)}`);

  const raw = await fetch(manifestUrl, { signal: AbortSignal.timeout(30_000) }).then((response) => {
    if (!response.ok) throw new Error(`manifest fetch failed: HTTP ${response.status}`);
    return response.text();
  });
  const { bundle } = parseUpdateManifest(raw, hostPlatformKey());
  const verdict = compareBundleIdentity(installed, bundle);
  const publishedLabel = describeIdentity({ commit: bundle.commit, version: bundle.version });

  if (verdict.kind === 'indeterminate' && !force) {
    console.log(`[beeline] cannot compare against the published bundle (${verdict.reason}).`);
    console.log('[beeline] re-run with --force to apply it anyway.');
    return;
  }

  if (checkOnly) {
    if (verdict.kind === 'update-available') {
      console.log(`[beeline] update available: ${publishedLabel}`);
      console.log(`[beeline] archive: ${archiveUrlFor(manifestUrl, bundle.file)}`);
    } else {
      console.log('[beeline] installed bundle is current.');
    }
    return;
  }

  if (verdict.kind === 'current' && !force) {
    console.log('[beeline] installed bundle is current; nothing to do.');
    return;
  }

  console.log(`[beeline] applying ${publishedLabel} …`);
  const manager = new SelfUpdateManager({
    layout,
    env: process.env,
    // No daemon context here: the CLI applies the bundle but NEVER restarts
    // anything itself — running daemons pick the swap up through their own
    // busy gate via the update request written below.
    isIdle: () => true,
    restartHandover: false,
  });
  await manager.checkAndApply({ force: true });
  console.log('[beeline] bundle applied (sha256 verified, previous release kept for rollback).');
  const running = await queueRestartOnRunningDaemons();
  if (running === 0) {
    console.log('[beeline] no running daemon found; the new bundle is used on the next `beeline start`.');
  }
}
