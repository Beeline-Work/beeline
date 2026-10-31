import { realpath } from 'node:fs/promises';
import { withKernelLock } from './kernel-lock.js';

/** Wait for the owner; a crashed process releases the kernel lock. */
export async function withCornerCheckoutLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const canonical = await realpath(path);
  return withKernelLock(`corner-checkout:${canonical}`, work, 2_147_483_647);
}
