import { resolve } from 'node:path';
import { beelineInstallLayout } from './self-update.js';
import { withKernelLock } from './kernel-lock.js';

export async function withAdapterInstallLock<T>(
  work: () => Promise<T> | T,
  env: NodeJS.ProcessEnv = process.env,
  waitMs = 600_000,
): Promise<T> {
  const layout = beelineInstallLayout(env);
  return layout
    ? withKernelLock(`beeline-install:${resolve(layout.libDir)}`, async () => work(), waitMs)
    : await work();
}
