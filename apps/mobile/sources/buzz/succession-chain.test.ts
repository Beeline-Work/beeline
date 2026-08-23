import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Identity } from '@beeline/buzz-client';

vi.mock('@beeline/buzz-client', () => ({
  fetchIdentityPredecessors: vi.fn(),
}));

import { fetchIdentityPredecessors } from '@beeline/buzz-client';
import { loadSuccessionPredecessors, resetSuccessionChainCache } from './succession-chain';

const identity = {
  publicKey: 'aa'.repeat(32),
  secretKey: new Uint8Array(32),
} as unknown as Pick<Identity, 'secretKey' | 'publicKey'>;

afterEach(() => {
  vi.clearAllMocks();
  resetSuccessionChainCache();
});

describe('succession chain loader', () => {
  it('returns the chain and caches it per pubkey for the session', async () => {
    vi.mocked(fetchIdentityPredecessors).mockResolvedValue(['old-key']);

    await expect(loadSuccessionPredecessors('https://relay.test', identity)).resolves.toEqual([
      'old-key',
    ]);
    await expect(loadSuccessionPredecessors('https://relay.test', identity)).resolves.toEqual([
      'old-key',
    ]);
    expect(fetchIdentityPredecessors).toHaveBeenCalledTimes(1);
  });

  it('degrades to an empty chain when the auth service is unreachable', async () => {
    vi.mocked(fetchIdentityPredecessors).mockRejectedValue(new Error('offline'));

    await expect(loadSuccessionPredecessors('https://relay.test', identity)).resolves.toEqual([]);
  });

  it('does not cache an empty chain, so a later retry can still find it', async () => {
    vi.mocked(fetchIdentityPredecessors)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['late-key']);

    await loadSuccessionPredecessors('https://relay.test', identity);
    await expect(loadSuccessionPredecessors('https://relay.test', identity)).resolves.toEqual([
      'late-key',
    ]);
  });
});
