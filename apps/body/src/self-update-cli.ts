/**
 * `beeline update` — the on-demand half of the daemon self-update path.
 *
 * Downloads and verifies the published bundle. A serving helper activates it
 * and restarts through its service manager in a quiet gap between turns.
 * With no helper running, the install is activated for the next start.
 */
import pc from 'picocolors';
import {
  formatAdapterInstallCommand,
  installLatestAgentAdapter,
  latestAdapterInstallCommand,
  type AdapterInstallCommand,
  type AgentKind,
} from './agent-command.js';
import { helperStatusLines } from './helper-status.js';
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
  discoveredBeelineInstallLayout,
  hostPlatformKey,
  readInstalledBundleIdentity,
  readUpdateState,
  type BeelineInstallLayout,
} from './self-update.js';
import {
  compareBundleIdentity,
  parseUpdateManifest,
  resolveManifestUrl,
} from './self-update-manifest.js';
import { withInstallLock } from './managed-update.js';

interface RuntimeAdapterRefreshOptions {
  env?: NodeJS.ProcessEnv;
  configPaths?: string[];
  readRuntime?: (path: string) => Promise<{ agentKind?: AgentKind }>;
  install?: (command: AdapterInstallCommand) => Promise<void>;
  readInstalledVersion?: (packageName: string) => Promise<string | undefined>;
  readLatestVersion?: (packageName: string) => Promise<string>;
  log?: (line: string) => void;
}

/**
 * Refresh each separable adapter once, no matter how many Room agents share
 * it. `beeline start` already enters through `runUpdateCommand`, so the same
 * pass covers direct `npx usebeeline update` and the whole start fan-out.
 */
export async function refreshRuntimeHarnessAdapters(
  options: RuntimeAdapterRefreshOptions = {},
): Promise<void> {
  const log = options.log ?? console.log;
  const readRuntime = options.readRuntime ?? readRuntimeRecord;
  const configPaths = options.configPaths ?? [
    ...(await findRuntimeConfigPaths(process.cwd()).catch(() => [] as string[])),
    ...(await findAgentRuntimeConfigPaths(process.env, process.cwd()).catch(() => [] as string[])),
  ];
  const kinds = new Set<AgentKind>();
  for (const path of new Set(configPaths)) {
    const runtime = await readRuntime(path).catch(() => undefined);
    if (runtime?.agentKind) kinds.add(runtime.agentKind);
  }
  for (const kind of kinds) {
    const command = latestAdapterInstallCommand(kind);
    if (!command) continue;
    log(`[beeline] refreshing ${kind} adapter: ${formatAdapterInstallCommand(command)}`);
    try {
      await installLatestAgentAdapter(kind, {
        ...(options.env ? { env: options.env } : {}),
        ...(options.install ? { install: options.install } : {}),
        ...(options.readInstalledVersion
          ? { readInstalledVersion: options.readInstalledVersion }
          : {}),
        ...(options.readLatestVersion ? { readLatestVersion: options.readLatestVersion } : {}),
      });
    } catch (error) {
      log(
        `[beeline] ${kind} adapter refresh failed; keeping the installed copy (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
}

function updateUsage(): void {
  console.log(`
${pc.bold('Update the installed Beeline bundle from the published manifest.')}

${pc.dim('Usage:')}
  beeline update                     Check, download, verify, and apply;
                                     running daemons restart onto it once idle
  beeline update --check             Report only — no download, no swap
  beeline update --status            Show installed identity, releases, and state
  beeline update --force             Apply even when the comparison is indeterminate
  beeline update --manifest-url <u>  Override the published manifest URL

The supervised helper checks the manifest on connection and on release notices,
then waits for a quiet gap to restart. BEELINE_UPDATE_DISABLE=1 turns the
automatic path off. \`beeline update\` always works.
`);
}

/**
 * Almost always the installed wrapper already exported BEELINE_LIB_DIR. The
 * one case it hasn't is `npx usebeeline update`: npx runs the CLI from a
 * throwaway npm cache, never through `<prefix>/bin/beeline`, so there is no
 * layout in the environment at all. Rather than refuse outright, locate the
 * installed bundle the way the installer laid it out
 * (`discoveredBeelineInstallLayout`) and delegate the update to IT — the
 * same install `beeline update` would have found. Only when no bundle
 * actually exists there does this still refuse, with the useful next step
 * instead of an installer-layout error that means nothing to an `npx` caller.
 */
export async function requireLayout(): Promise<BeelineInstallLayout> {
  const layout = beelineInstallLayout(process.env);
  if (layout) return layout;
  const discovered = discoveredBeelineInstallLayout(process.env);
  if ((await readInstalledBundleIdentity(discovered)) !== undefined) return discovered;
  throw new Error('this host has no Beeline install; run `npx usebeeline connect` first.');
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
  const [helper, ...agents] = await helperStatusLines();
  console.log(`${pc.bold('helper')}            ${helper}`);
  for (const line of agents) console.log(`  ${line}`);
  const installed = await readInstalledBundleIdentity(layout);
  const active = await activeReleaseId(layout);
  const state = await readUpdateState(layout);
  console.log(`${pc.bold('installed bundle')}  ${describeIdentity(installed)}`);
  console.log(`${pc.bold('active release')}    ${active ?? 'none (legacy layout, never updated)'}`);
  if (state.lastCheckAt) {
    console.log(
      `${pc.bold('last check')}         ${new Date(state.lastCheckAt).toISOString()} — ${state.lastCheckResult ?? 'unknown'}`,
    );
  }
}

async function reportRunningDaemons(): Promise<number> {
  const running = await runningDaemonConfigPaths();
  for (const configPath of running) {
    const runtime = await readRuntimeRecord(configPath).catch(() => undefined);
    console.log(
      `[beeline] daemon ${runtime?.agent.publicKey?.slice(0, 12) ?? configPath} is running; ` +
        'it will activate the staged bundle and restart in a quiet gap; unfinished work resumes.',
    );
  }
  return running.length;
}

export async function runUpdateCommand(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    updateUsage();
    return;
  }

  const supported = new Set(['update', '--check', '--status', '--force', '--manifest-url']);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!supported.has(arg)) throw new Error(`unknown update argument: ${arg}`);
    if (arg === '--manifest-url') {
      if (!args[++index]) throw new Error('--manifest-url requires a URL');
    }
  }

  const layout = await requireLayout();
  const manifestUrlFlag = args.indexOf('--manifest-url');
  const manifestUrl =
    manifestUrlFlag >= 0 && args[manifestUrlFlag + 1]
      ? args[manifestUrlFlag + 1]!
      : resolveManifestUrl(process.env);
  const checkOnly = args.includes('--check');
  const force = args.includes('--force');

  if (args.includes('--status')) {
    await printStatus(layout);
    return;
  }

  // `--check` is explicitly report-only. Every mutating update, including the
  // update pass `beeline start` performs before launching its fan-out, also
  // advances installed ACP adapters to the registry's current release.
  if (!checkOnly)
    await refreshRuntimeHarnessAdapters({
      env: { ...process.env, BEELINE_LIB_DIR: layout.libDir },
    });

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
  const running = await reportRunningDaemons();
  const manager = new SelfUpdateManager({
    layout,
    env: { ...process.env, BEELINE_UPDATE_MANIFEST_URL: manifestUrl },
    // A serving helper owns activation at its idle gate. With no helper,
    // activate now so the next start uses the new bundle.
    isIdle: () => true,
    stageOnly: running > 0,
  });
  await withInstallLock(layout, () => manager.checkAndApply({ force: true }));
  console.log(running > 0
    ? '[beeline] bundle staged (sha256 verified); the helper will install and restart in a quiet gap.'
    : '[beeline] bundle applied (sha256 verified).');
  if (running === 0) {
    console.log(
      '[beeline] no running daemon found; the new bundle is used on the next `beeline start`.',
    );
  }
}
