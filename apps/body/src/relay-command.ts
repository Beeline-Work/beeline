import {
  findAgentRuntimeConfigPaths,
  findRuntimeConfigPaths,
  launchRuntimeDaemon,
  normalizeRelayBaseUrl,
  readRuntimeRecord,
  resolveRuntimeConfigPath,
  selectRuntimeConfigPaths,
  stopRuntimeDaemon,
  updateRuntimeRelay,
} from './runtime.js';

interface RelayCommandDependencies {
  cwd: () => string;
  findHostRuntimes: (cwd: string) => Promise<string[]>;
  findRepositoryRuntimes: (cwd: string) => Promise<string[]>;
  resolveConfig: typeof resolveRuntimeConfigPath;
  readRuntime: typeof readRuntimeRecord;
  stopRuntime: typeof stopRuntimeDaemon;
  updateRuntime: typeof updateRuntimeRelay;
  launchRuntime: typeof launchRuntimeDaemon;
  log: (message: string) => void;
}

const defaults: RelayCommandDependencies = {
  cwd: () => process.cwd(),
  findHostRuntimes: (cwd) => findAgentRuntimeConfigPaths(process.env, cwd),
  findRepositoryRuntimes: findRuntimeConfigPaths,
  resolveConfig: resolveRuntimeConfigPath,
  readRuntime: readRuntimeRecord,
  stopRuntime: stopRuntimeDaemon,
  updateRuntime: updateRuntimeRelay,
  launchRuntime: launchRuntimeDaemon,
  log: console.log,
};

/** Repoint selected stored runtimes and restart their daemons. */
export async function runRelayCommand(
  args: string[],
  overrides: Partial<RelayCommandDependencies> = {},
): Promise<void> {
  const deps = { ...defaults, ...overrides };
  if (args[1] !== 'set' || !args[2]) {
    throw new Error('usage: beeline relay set <http-or-https-origin> [--agent <pubkey>|--all]');
  }
  const requestedRelay = normalizeRelayBaseUrl(args[2]);
  const allFlag = args.includes('--all');
  const agentFlag = args.indexOf('--agent');
  const requestedPubkey = agentFlag >= 0 ? args[agentFlag + 1] : undefined;
  if (agentFlag >= 0 && !requestedPubkey) throw new Error('--agent requires an agent pubkey');
  if (allFlag && requestedPubkey) throw new Error('choose either --all or --agent, not both');

  const knownValues = new Set([
    'relay',
    'set',
    args[2],
    '--all',
    '--agent',
    ...(requestedPubkey ? [requestedPubkey] : []),
  ]);
  const unknown = args.find((value) => !knownValues.has(value));
  if (unknown) throw new Error(`unknown relay option: ${unknown}`);

  const cwd = deps.cwd();
  const { paths: unique } = await selectRuntimeConfigPaths({
    cwd,
    all: allFlag,
    requestedPubkey,
    findHostRuntimes: deps.findHostRuntimes,
    findRepositoryRuntimes: deps.findRepositoryRuntimes,
    noRuntimeMessage: (hostScope) =>
      requestedPubkey
        ? `no paired agent runtime found for ${requestedPubkey}`
        : hostScope
          ? 'no paired agent runtime found on this host'
          : 'no paired agent runtime found in this repository',
    multipleRuntimeMessage: 'multiple paired agents match that pubkey; pass the full agent pubkey',
  });

  deps.log(`[buzz] found ${unique.length} paired agent runtime(s); updating ${unique.length}.`);
  let updated = 0;
  for (const path of unique) {
    const configPath = await deps.resolveConfig(path);
    const before = await deps.readRuntime(configPath);
    const stoppedPid = await deps.stopRuntime(configPath);
    try {
      await deps.updateRuntime(configPath, requestedRelay.relayBaseUrl);
    } catch (error) {
      if (stoppedPid) await deps.launchRuntime(configPath).catch(() => undefined);
      throw error;
    }
    let pid: number;
    try {
      pid = await deps.launchRuntime(configPath);
    } catch (error) {
      throw new Error(
        `relay was updated to ${requestedRelay.relayBaseUrl}, but the daemon did not restart; ` +
          `run \`beeline start --agent ${before.agent.publicKey}\`: ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
    }
    updated += 1;
    deps.log(
      `[buzz] agent ${before.agent.publicKey} relay: ${before.relayBaseUrl} -> ${requestedRelay.relayBaseUrl}`,
    );
    deps.log(`[buzz] agent daemon restarted (pid ${pid})`);
  }
  deps.log(`[buzz] updated ${updated} paired agent runtime(s).`);
}
