import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));

import { loadStoredPushLevel, saveStoredPushLevel } from './push-level-storage';

describe('push level storage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('defaults missing and invalid values to mine', async () => {
    storage.getItem.mockResolvedValueOnce(null).mockResolvedValueOnce('loud');
    await expect(loadStoredPushLevel('person')).resolves.toBe('mine');
    await expect(loadStoredPushLevel('person')).resolves.toBe('mine');
  });

  it('round-trips a server-proven level for launch reconciliation', async () => {
    storage.setItem.mockResolvedValue(undefined);
    await saveStoredPushLevel('person', 'off');
    expect(storage.setItem).toHaveBeenCalledWith('@beeline/push-level/person', 'off');
  });
});
