import { resolve } from 'node:path';
import { adapterStoreRoot } from './adapter-store.js';
import { withKernelLock } from './kernel-lock.js';

export async function withAdapterInstallLock<T>(
  work: () => Promise<T> | T,
  env: NodeJS.ProcessEnv = process.env,
  waitMs = 600_000,
): Promise<T> {
  return withKernelLock(`beeline-adapters:${resolve(adapterStoreRoot(env))}`, async () => work(), waitMs);
}
