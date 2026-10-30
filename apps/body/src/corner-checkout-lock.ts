import { realpath } from 'node:fs/promises';
import { withKernelLock } from './kernel-lock.js';

/** Refuse before activation or git sync; a crashed helper leaves no stale lock. */
export async function withCornerCheckoutLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const canonical = await realpath(path);
  let entered = false;
  try {
    return await withKernelLock(`corner-checkout:${canonical}`, async () => {
      entered = true;
      return work();
    }, 0);
  } catch (error) {
    if (!entered && error instanceof Error && error.message === 'timed out waiting for Beeline installer owner')
      throw new Error('corner checkout is in use by another agent; retry after its turn and background tools finish');
    throw error;
  }
}
