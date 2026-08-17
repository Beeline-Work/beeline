import { beforeEach, describe, expect, it, vi } from 'vitest';

const verifyNip05 = vi.hoisted(() => vi.fn());

vi.mock('@beeline/buzz-client', () => ({ verifyNip05 }));

import {
  getCachedNip05Status,
  resolveNip05Status,
  resolveNip05StatusMap,
} from './nip05-verification';

const pubkey = 'a'.repeat(64);
const other = 'b'.repeat(64);

describe('nip05 verification cache', () => {
  beforeEach(() => {
    verifyNip05.mockReset();
  });

  it('has nothing cached before a lookup runs', () => {
    expect(getCachedNip05Status(pubkey, 'nobody@example.com')).toBeUndefined();
  });

  it('resolves and caches a verified result', async () => {
    verifyNip05.mockResolvedValue({ identifier: 'ada@example.com', status: 'verified' });
    const status = await resolveNip05Status(pubkey, 'ada@example.com');
    expect(status).toBe('verified');
    expect(getCachedNip05Status(pubkey, 'ada@example.com')).toBe('verified');
    expect(verifyNip05).toHaveBeenCalledTimes(1);

    // A second resolve reuses the cache instead of calling verifyNip05 again.
    await resolveNip05Status(pubkey, 'ada@example.com');
    expect(verifyNip05).toHaveBeenCalledTimes(1);
  });

  it('caches a mismatch honestly rather than treating it as verified', async () => {
    verifyNip05.mockResolvedValue({ identifier: 'bea@example.com', status: 'mismatch' });
    const status = await resolveNip05Status(pubkey, 'bea@example.com');
    expect(status).toBe('mismatch');
    expect(getCachedNip05Status(pubkey, 'bea@example.com')).toBe('mismatch');
  });

  it('caches per pubkey+identifier pair independently', async () => {
    verifyNip05.mockResolvedValueOnce({ identifier: 'cleo@example.com', status: 'verified' });
    verifyNip05.mockResolvedValueOnce({ identifier: 'cleo@example.com', status: 'mismatch' });
    await resolveNip05Status(pubkey, 'cleo@example.com');
    await resolveNip05Status(other, 'cleo@example.com');
    expect(getCachedNip05Status(pubkey, 'cleo@example.com')).toBe('verified');
    expect(getCachedNip05Status(other, 'cleo@example.com')).toBe('mismatch');
  });

  it('batch-resolves a status map, skipping entries without a nip05', async () => {
    verifyNip05.mockResolvedValue({ identifier: 'dara@example.com', status: 'verified' });
    const map = await resolveNip05StatusMap([
      { pubkey, nip05: 'dara@example.com' },
      { pubkey: other },
    ]);
    expect(map.get(pubkey)).toBe('verified');
    expect(map.has(other)).toBe(false);
  });
});
