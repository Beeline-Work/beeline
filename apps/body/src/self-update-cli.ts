/**
 * `beeline update` — the on-demand half of the daemon self-update path.
 *
 * Applies the published bundle to the local install (download, sha256
 * verify, atomic swap) and records one bounded confirmation attempt. Running
 * daemons observe the stable anchor at their completed progress tick, drain,
 * then restart through systemd; the replacement must serve a real turn before
 * the deadline or the anchor is rolled back and a durable alert is recorded.
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
  readInstalledBundleIdentity,
  readUpdateAttempt,
  readUpdateState,
  rollbackToPreviousRelease,
  writeUpdateAttempt,
  type BeelineInstallLayout,
} from './self-update.js';
import {
  compareBundleIdentity,
  parseUpdateManifest,
  resolveManifestUrl,
} from './self-update-manifest.js';
import { withInstallLock } from './managed-update.js';

function updateUsage(): void {
  console.log(`
${pc.bold('Update the installed Beeline bundle from the published manifest.')}

${pc.dim('Usage:')}
  beeline update                     Check, download, verify, and apply;
                                     running daemons restart onto it once idle
  beeline update --check             Report only — no download, no swap
  beeline update --status            Show installed identity, releases, and state
  beeline update --rollback          Restore the previous release (stable-anchor restart)
  beeline update --force             Apply even when the comparison is indeterminate
  beeline update --manifest-url <u>  Override the published manifest URL

The supervised daemon also checks automatically (every BEELINE_UPDATE_INTERVAL_MS,
default 30s) with the same busy gate; BEELINE_UPDATE_DISABLE=1 turns the
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
  const attempt = await readUpdateAttempt(layout);
  console.log(`${pc.bold('installed bundle')}  ${describeIdentity(installed)}`);
  console.log(`${pc.bold('active release')}    ${active ?? 'none (legacy layout, never updated)'}`);
  if (state.lastCheckAt) {
    console.log(
      `${pc.bold('last check')}         ${new Date(state.lastCheckAt).toISOString()} — ${state.lastCheckResult ?? 'unknown'}`,
    );
  }
  if (attempt) {
    console.log(
      `${pc.bold('update attempt')}      ${attempt.status}: ${describeIdentity(attempt.to)} ` +
        `(previous: ${attempt.previousReleaseId ?? 'none'}, confirm by ${new Date(attempt.confirmBy).toISOString()})` +
        `${attempt.failure ? ` — ${attempt.failure}` : ''}`,
    );
  }
}

async function runningDaemonProbeIds(): Promise<string[]> {
  const running = await runningDaemonConfigPaths();
  const ids: string[] = [];
  for (const configPath of running) {
    const runtime = await readRuntimeRecord(configPath).catch(() => undefined);
    if (runtime?.agent.publicKey) ids.push(runtime.agent.publicKey);
    console.log(
      `[beeline] daemon ${runtime?.agent.publicKey?.slice(0, 12) ?? configPath} is running; ` +
        'it will observe the install anchor and restart once its current work finishes (never mid-turn).',
    );
  }
  return [...new Set(ids)].sort();
}

export async function runUpdateCommand(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    updateUsage();
    return;
  }

  const layout = requireLayout();
  const manifestUrlFlag = args.indexOf('--manifest-url');
  const manifestUrl =
    manifestUrlFlag >= 0 && args[manifestUrlFlag + 1]
      ? args[manifestUrlFlag + 1]!
      : resolveManifestUrl(process.env);
  const checkOnly = args.includes('--check');
  const force = args.includes('--force');
  const rollback = args.includes('--rollback');

  if (rollback) {
    const attempt = await readUpdateAttempt(layout);
    const previous = attempt?.previousReleaseId;
    if (!previous) throw new Error('no previous release recorded to roll back to');
    await withInstallLock(layout, async () => {
      await rollbackToPreviousRelease(layout, previous);
      await writeUpdateAttempt(layout, {
        ...attempt,
        status: 'reverted',
        failure: 'operator rolled the release back',
      });
    });
    console.log(`[beeline] rolled back to release ${previous}.`);
    const running = await runningDaemonProbeIds();
    console.log(
      running.length > 0
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
  const requiredProbeIds = await runningDaemonProbeIds();
  const manager = new SelfUpdateManager({
    layout,
    env: process.env,
    // This command only swaps the stable anchor. The daemon coordinator owns
    // every restart after it observes that anchor on a completed tick.
    isIdle: () => true,
    requiredProbeIds,
  });
  await withInstallLock(layout, () => manager.checkAndApply({ force: true }));
  console.log('[beeline] bundle applied (sha256 verified, previous release kept for rollback).');
  if (requiredProbeIds.length === 0) {
    console.log(
      '[beeline] no running daemon found; the new bundle is used on the next `beeline start`.',
    );
  }
}
