import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => void storage.set(key, value)),
    removeItem: vi.fn(async (key: string) => void storage.delete(key)),
  },
}));

import { clearPendingInvite, loadPendingInvite, savePendingInvite } from './pending-invite';

const TOKEN = `inv_${'a'.repeat(64)}`;

describe('an invite kept through sign-in', () => {
  beforeEach(() => storage.clear());

  it('keeps a token or a full link, and hands back the token', async () => {
    await savePendingInvite(`https://usebeeline.app/join/${TOKEN}`, 1_000);
    expect(await loadPendingInvite(2_000)).toBe(TOKEN);
    await clearPendingInvite();
    expect(await loadPendingInvite(2_000)).toBeNull();
  });

  it('ignores something that is not an invite', async () => {
    await savePendingInvite('https://example.com/not-an-invite', 1_000);
    expect(await loadPendingInvite(2_000)).toBeNull();
  });

  it('forgets an invite parked longer than an invite can live', async () => {
    await savePendingInvite(TOKEN, 0);
    expect(await loadPendingInvite(8 * 24 * 60 * 60 * 1000)).toBeNull();
    expect(storage.size).toBe(0);
  });
});
