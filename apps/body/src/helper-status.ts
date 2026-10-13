import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { daemonFailurePath } from './daemon-failure.js';
import {
  defaultSupervisorRoot,
  findAgentRuntimeConfigPaths,
  helperStateDirectory,
  isAgentStopped,
  readRuntimeRecord,
} from './runtime.js';

export type AgentSlotState =
  'starting' | 'serving' | 'restarting' | 'needs-auth' | 'needs-config' | 'stopped' | 'removed';

/** What the machine helper last said about each agent it hosts. Local file, never a server read. */
export interface HelperStatusFile {
  readonly pid: number;
  readonly generation: string;
  readonly processState: 'starting' | 'serving' | 'stopping';
  readonly desiredRelease?: string;
  readonly loadedRelease?: string;
  readonly loadedIdentity?: { version?: string; commit?: string };
  readonly updatedAt: string;
  readonly agents: Readonly<
    Record<
      string,
      {
        readonly state: AgentSlotState;
        readonly enabled?: boolean;
        readonly status: string;
        readonly lastError?: string;
        readonly since: string;
      }
    >
  >;
}

export function helperStatusPath(supervisorRoot: string): string {
  return resolve(helperStateDirectory(supervisorRoot), 'status.json');
}

/** One line for the helper and one per paired agent, for `beeline update --status`. */
export async function helperStatusLines(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const status = await readMachineStatus(env);
  const pid = status?.pid;
  const hosted = status?.agents ?? {};
  const lines = [pid ? `running (pid ${pid}; one process for every agent)` : 'not running'];
  for (const configPath of await findAgentRuntimeConfigPaths(env).catch(() => [] as string[])) {
    const runtime = await readRuntimeRecord(configPath).catch(() => undefined);
    const key = runtime?.agent.publicKey ?? dirname(configPath).split('/').at(-1) ?? configPath;
    const entry = hosted[key];
    const diagnostic = await stat(daemonFailurePath(dirname(configPath)))
      .then(
        async () =>
          JSON.parse(await readFile(daemonFailurePath(dirname(configPath)), 'utf8')) as {
            lastError?: string;
          },
      )
      .catch(() => undefined);
    const state = (await isAgentStopped(configPath))
      ? 'stopped (beeline stop)'
      : entry
        ? `${entry.state} since ${entry.since}${entry.status ? ` — ${entry.status}` : ''}`
        : diagnostic?.lastError
          ? `not serving — last failure: ${diagnostic.lastError}`
          : pid
            ? 'not hosted yet'
            : 'not running';
    lines.push(`agent ${key.slice(0, 12)}  ${state}`);
  }
  return lines;
}

export async function readMachineStatus(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HelperStatusFile | undefined> {
  const { requestMachine } = await import('./machine-control.js');
  return requestMachine(
    defaultSupervisorRoot(env),
    { operation: 'status' },
    () => true,
    2000,
  ).catch(() => undefined);
}
