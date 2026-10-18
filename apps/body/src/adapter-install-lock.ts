import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { withKernelLock } from './kernel-lock.js';

export async function withAdapterInstallLock<T>(
  work: () => Promise<T> | T,
  env: NodeJS.ProcessEnv = process.env,
  waitMs = 600_000,
): Promise<T> {
  // CLI, bootstrap and daemon can have different bundle anchors while sharing
  // the same dependency prefix. The prefix owns exclusion in every case.
  const root = resolve(env.XDG_DATA_HOME || resolve(env.HOME || homedir(), '.local/share'), 'beeline/toolchain');
  return withKernelLock(`beeline-toolchain:${root}`, async () => work(), waitMs);
}
