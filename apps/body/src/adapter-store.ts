import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const MANAGED_ADAPTERS = {
  codex: { packageName: '@agentclientprotocol/codex-acp', binary: 'codex-acp' },
  claude: { packageName: '@agentclientprotocol/claude-agent-acp', binary: 'claude-agent-acp' },
  pi: { packageName: 'pi-acp', binary: 'pi-acp' },
} as const;
export type ManagedAdapterKind = keyof typeof MANAGED_ADAPTERS;

export interface AdapterState {
  active?: {
    version: string;
    command: string;
    negotiated?: { protocolVersion: number; agentCapabilities: Record<string, unknown> };
  };
  rejected?: Record<string, { error: string }>;
}

/** Independent of bundle generations and npm's mutable global prefix. */
export function adapterStoreRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || homedir();
  return resolve(env.XDG_DATA_HOME || join(home, '.local/share'), 'beeline/adapters');
}

export function adapterStatePath(kind: ManagedAdapterKind, env: NodeJS.ProcessEnv): string {
  return join(adapterStoreRoot(env), kind, 'state.json');
}

export function readAdapterState(kind: ManagedAdapterKind, env: NodeJS.ProcessEnv): AdapterState {
  try {
    return JSON.parse(readFileSync(adapterStatePath(kind, env), 'utf8')) as AdapterState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

/** Every resolver uses the same atomic pointer, including persisted legacy commands. */
export function activeAdapterCommand(
  kind: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!Object.hasOwn(MANAGED_ADAPTERS, kind)) return undefined;
  return readAdapterState(kind as ManagedAdapterKind, env).active?.command;
}
