import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { InstalledBundleIdentity } from './self-update-manifest.js';

export const DAEMON_RELEASE_STATUS_FILE = 'release-status.json';
const RELEASE_VERSION = /^v\d+\.\d+\.\d+$/;
const SOURCE_SHA = /^[0-9a-f]{7,64}$/;
const AGENT_PUBKEY = /^[0-9a-f]{64}$/;

export interface DaemonReleaseStatus {
  schemaVersion: 1;
  releaseVersion: string;
  sourceSha: string;
  agentPubkey: string;
  pid: number;
  readyAt: string;
}

export interface DaemonReleaseFleetEntry {
  agentPubkey: string;
  state: 'ready' | 'missing' | 'stale' | 'invalid';
  releaseVersion?: string;
  sourceSha?: string;
  pid?: number;
  readyAt?: string;
}

function validStatus(value: unknown): value is DaemonReleaseStatus {
  if (!value || typeof value !== 'object') return false;
  const status = value as Partial<DaemonReleaseStatus>;
  return (
    status.schemaVersion === 1 &&
    typeof status.releaseVersion === 'string' &&
    RELEASE_VERSION.test(status.releaseVersion) &&
    typeof status.sourceSha === 'string' &&
    SOURCE_SHA.test(status.sourceSha) &&
    typeof status.agentPubkey === 'string' &&
    AGENT_PUBKEY.test(status.agentPubkey) &&
    Number.isSafeInteger(status.pid) &&
    Number(status.pid) > 0 &&
    typeof status.readyAt === 'string'
  );
}

export async function writeDaemonReleaseStatus(
  runtimeDir: string,
  agentPubkey: string,
  identity: InstalledBundleIdentity | undefined,
  options: { pid?: number; now?: () => Date } = {},
): Promise<DaemonReleaseStatus | undefined> {
  if (
    !identity?.version ||
    !RELEASE_VERSION.test(identity.version) ||
    !identity.commit ||
    !SOURCE_SHA.test(identity.commit) ||
    !AGENT_PUBKEY.test(agentPubkey)
  ) {
    return undefined;
  }
  const status: DaemonReleaseStatus = {
    schemaVersion: 1,
    releaseVersion: identity.version,
    sourceSha: identity.commit,
    agentPubkey,
    pid: options.pid ?? process.pid,
    readyAt: (options.now?.() ?? new Date()).toISOString(),
  };
  const target = resolve(runtimeDir, DAEMON_RELEASE_STATUS_FILE);
  const temporary = `${target}.${status.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
  return status;
}

export function daemonAgentsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const stateHome = env.XDG_STATE_HOME?.trim() || resolve(env.HOME || '', '.local', 'state');
  return resolve(stateHome, 'beeline', 'agents');
}

export async function readDaemonReleaseFleetStatus(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DaemonReleaseFleetEntry[]> {
  const root = daemonAgentsRoot(env);
  const directories = await readdir(root, { withFileTypes: true }).catch(() => []);
  const agents = directories
    .filter((entry) => entry.isDirectory() && AGENT_PUBKEY.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  return Promise.all(
    agents.map(async (agentPubkey): Promise<DaemonReleaseFleetEntry> => {
      const runtimeDir = resolve(root, agentPubkey);
      const runtime = await readFile(resolve(runtimeDir, 'runtime.json'), 'utf8').catch(() => '');
      if (!runtime) return { agentPubkey, state: 'invalid' };
      const raw = await readFile(resolve(runtimeDir, DAEMON_RELEASE_STATUS_FILE), 'utf8').catch(
        () => '',
      );
      if (!raw) return { agentPubkey, state: 'missing' };
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { agentPubkey, state: 'invalid' };
      }
      if (!validStatus(parsed) || parsed.agentPubkey !== agentPubkey) {
        return { agentPubkey, state: 'invalid' };
      }
      const pid = Number(
        (await readFile(resolve(runtimeDir, 'daemon.pid'), 'utf8').catch(() => '')).trim(),
      );
      return {
        agentPubkey,
        state: pid === parsed.pid ? 'ready' : 'stale',
        releaseVersion: parsed.releaseVersion,
        sourceSha: parsed.sourceSha,
        pid: parsed.pid,
        readyAt: parsed.readyAt,
      };
    }),
  );
}
