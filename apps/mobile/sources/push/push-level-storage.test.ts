import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));

import {
  loadStoredPushLevel,
  saveStoredPushLevel,
  subscribeStoredPushLevel,
  watchStoredPushLevel,
} from './push-level-storage';

describe('push level storage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('defaults missing and invalid values to Attention', async () => {
    storage.getItem.mockResolvedValueOnce(null).mockResolvedValueOnce('loud');
    await expect(loadStoredPushLevel('person')).resolves.toBe('attention');
    await expect(loadStoredPushLevel('person')).resolves.toBe('attention');
  });

  it.each([
    ['off', 'off'],
    ['direct', 'attention'],
    ['mine', 'attention'],
    ['all', 'full'],
  ])('maps cached legacy %s to %s', async (legacy, mapped) => {
    storage.getItem.mockResolvedValueOnce(legacy);
    await expect(loadStoredPushLevel('person')).resolves.toBe(mapped);
  });

  it('round-trips a server-proven level for launch reconciliation', async () => {
    storage.setItem.mockResolvedValue(undefined);
    await saveStoredPushLevel('person', 'off');
    expect(storage.setItem).toHaveBeenCalledWith('@beeline/push-level/person', 'off');
  });

  it('tells mounted readers about a new level once it is durable', async () => {
    storage.setItem.mockResolvedValue(undefined);
    const listener = vi.fn(() => expect(storage.setItem).toHaveBeenCalled());
    const stop = subscribeStoredPushLevel(listener);
    await saveStoredPushLevel('person', 'full');
    expect(listener).toHaveBeenCalledWith('person', 'full');
    stop();
    await saveStoredPushLevel('person', 'off');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('seeds a watcher from the device copy, then follows only its own identity', async () => {
    storage.getItem.mockResolvedValueOnce('off');
    storage.setItem.mockResolvedValue(undefined);
    const listener = vi.fn();
    const stop = watchStoredPushLevel('person', listener);
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith('off'));
    await saveStoredPushLevel('someone-else', 'full');
    await saveStoredPushLevel('person', 'full');
    expect(listener.mock.calls).toEqual([['off'], ['full']]);
    stop();
    await saveStoredPushLevel('person', 'attention');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('never lets a late device copy overwrite a level a save already announced', async () => {
    let resolveRead: (value: string) => void = () => undefined;
    storage.getItem.mockReturnValueOnce(new Promise((resolve) => (resolveRead = resolve)));
    storage.setItem.mockResolvedValue(undefined);
    const listener = vi.fn();
    const stop = watchStoredPushLevel('person', listener);
    await saveStoredPushLevel('person', 'full');
    resolveRead('off');
    await Promise.resolve();
    await Promise.resolve();
    expect(listener.mock.calls).toEqual([['full']]);
    stop();
  });
});
