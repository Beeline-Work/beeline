import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { redactDiagnostic } from '@beeline/api-contract/error-reporting';
import {
  installedAgentProgramEnvironment,
  runAdapterInstall,
  type AdapterInstallCommand,
} from './agent-command.js';
import { withAdapterInstallLock } from './adapter-install-lock.js';
import { checkAdapterSession } from './adapter-session-check.js';
import {
  adapterStatePath,
  adapterStoreRoot,
  MANAGED_ADAPTERS,
  readAdapterState,
  type AdapterState,
  type ManagedAdapterKind,
} from './adapter-store.js';
import { captureHelperError, flushHelperErrors } from './sentry.js';

export const ADAPTER_RELEASE_AGE_MS = 24 * 60 * 60_000;
export interface AdapterRegistry {
  'dist-tags': { latest: string };
  time: Record<string, string>;
}
export interface AdapterUpdateOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: 'inherit' | 'ignore';
  readRegistry?: (packageName: string) => Promise<AdapterRegistry>;
  install?: (command: AdapterInstallCommand) => Promise<void>;
  checkSession?: typeof checkAdapterSession;
  alert?: (error: Error) => Promise<void>;
  now?: () => number;
}

/** Follow npm's latest release channel, with one day for newly published releases. */
export function agedAdapterVersion(registry: AdapterRegistry, now: number): string | undefined {
  const latest = registry['dist-tags'].latest;
  const latestTime = Date.parse(registry.time[latest] ?? '');
  if (now - latestTime >= ADAPTER_RELEASE_AGE_MS) return latest;
  // npm time includes created/modified and prerelease channels. Only previous
  // releases in the latest channel are fallback candidates while latest ages.
  const rank = (version: string) => version.split('.').map(Number);
  const compare = (a: string, b: string) => {
    const av = rank(a),
      bv = rank(b);
    return av[0]! - bv[0]! || av[1]! - bv[1]! || av[2]! - bv[2]!;
  };
  return Object.keys(registry.time)
    .filter(
      (version) =>
        /^\d+\.\d+\.\d+$/.test(version) &&
        compare(version, latest) <= 0 &&
        now - Date.parse(registry.time[version]!) >= ADAPTER_RELEASE_AGE_MS,
    )
    .sort((a, b) => compare(b, a))[0];
}

async function publishedAdapters(
  packageName: string,
  env: NodeJS.ProcessEnv,
): Promise<AdapterRegistry> {
  const { stdout } = await promisify(execFile)(
    'npm',
    ['view', packageName, 'dist-tags', 'time', '--json'],
    {
      env,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout) as AdapterRegistry;
}

async function writeState(
  kind: ManagedAdapterKind,
  env: NodeJS.ProcessEnv,
  state: AdapterState,
): Promise<void> {
  const path = adapterStatePath(kind, env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const staged = `${path}.${process.pid}.tmp`;
  await writeFile(staged, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(staged, path);
}

export async function updateAgentAdapter(
  kind: ManagedAdapterKind,
  options: AdapterUpdateOptions,
): Promise<boolean> {
  const env = options.env ?? process.env;
  const adapter = MANAGED_ADAPTERS[kind];
  return withAdapterInstallLock(async () => {
    const state = readAdapterState(kind, env);
    let version: string | undefined;
    try {
      version = agedAdapterVersion(
        await (options.readRegistry ?? ((name) => publishedAdapters(name, env)))(
          adapter.packageName,
        ),
        (options.now ?? Date.now)(),
      );
    } catch {
      // Registry outages never remove or reinstall a working adapter.
      return false;
    }
    if (!version || state.active?.version === version || state.rejected?.[version]) return false;
    const directory = join(adapterStoreRoot(env), kind);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Unique prefixes are immutable after adoption. Even a killed installer
    // cannot leave a partial install at a working version's command path.
    const candidate = await mkdtemp(join(directory, 'candidate-'));
    let promoted = false;
    try {
      const install: AdapterInstallCommand = {
        command: 'npm',
        args: [
          'install',
          '--prefix',
          candidate,
          '--no-save',
          '--no-audit',
          '--no-fund',
          `${adapter.packageName}@${version}`,
        ],
      };
      await (options.install ?? ((command) => runAdapterInstall(command, { ...options, env })))(
        install,
      );
      const command = join(candidate, 'node_modules/.bin', adapter.binary);
      const agentEnv = Object.fromEntries(
        Object.entries({ ...env, ...installedAgentProgramEnvironment(kind, env) }).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
      let negotiated: Awaited<ReturnType<typeof checkAdapterSession>>;
      try {
        negotiated = await (options.checkSession ?? checkAdapterSession)({
          command,
          env: agentEnv,
        });
      } catch (error) {
        const detail = redactDiagnostic(error instanceof Error ? error.message : String(error))
          .replace(/\s+/g, ' ')
          .slice(0, 1800);
        // Persist rejection under the same kernel lock as promotion. Other
        // helpers and future starts neither retry nor alert for this version.
        state.rejected = { ...state.rejected, [version]: { error: detail } };
        await writeState(kind, env, state);
        const alert = new Error(
          `Beeline ACP adapter rejected ${adapter.packageName}@${version}: ${detail}`,
        );
        alert.name = `AdapterCompatibilityError:${kind}@${version}`;
        await (
          options.alert ??
          (async (failure) => {
            // Existing helper Sentry -> /api/webhooks/sentry -> Telegram channel.
            captureHelperError(failure);
            await flushHelperErrors();
          })
        )(alert);
        return false;
      }
      await writeState(kind, env, { ...state, active: { version, command, negotiated } });
      promoted = true;
      return true;
    } finally {
      if (!promoted) await rm(candidate, { recursive: true, force: true });
    }
  }, env);
}
