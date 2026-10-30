import { expect, it, vi } from 'vitest';
import { fetchStoreUpdate, requiredStoreUpdate } from './store-update';

const minimum = { minVersion: '0.2.24', reason: 'This version can no longer sign in.' };
const policy = { android: minimum, ios: { ...minimum, minVersion: '0.3.0' } };

it('compares native versions below, equal and above numerically for each platform', () => {
  expect(requiredStoreUpdate('android', '0.2.22', policy)).toEqual(minimum);
  expect(requiredStoreUpdate('android', '0.2.24', policy)).toBeNull();
  expect(requiredStoreUpdate('android', '0.2.100', policy)).toBeNull();
  expect(requiredStoreUpdate('ios', '0.2.24', policy)?.minVersion).toBe('0.3.0');
  expect(requiredStoreUpdate('ios', '0.3.0', policy)).toBeNull();
  expect(requiredStoreUpdate('ios', '1.0.0', policy)).toBeNull();
});

it('ignores OTA ids, runtime pins and manifest versions', () => {
  for (const updateId of ['old-update', 'nightly-update']) {
    expect(requiredStoreUpdate('android', '0.2.24', { ...policy, updateId, version: '99.0.0', runtimeVersion: '999' })).toBeNull();
    expect(requiredStoreUpdate('android', '0.2.22', { ...policy, updateId })).toEqual(minimum);
  }
  expect(requiredStoreUpdate('android', '0.2.22', { updateId: 'nightly-update' })).toBeNull();
});

it('fails open for missing or invalid policy and unknown native versions', () => {
  for (const value of [null, {}, [], 'invalid', { android: {} }, { android: { ...minimum, reason: '' } },
    { android: { ...minimum, minVersion: '1.0' } }, { android: { ...minimum, minVersion: '999999999999999999999.0.0' } }]) {
    expect(requiredStoreUpdate('android', '0.2.22', value)).toBeNull();
  }
  for (const installed of [null, 'invalid', '0.2', '99999999999999999999.0.0']) {
    expect(requiredStoreUpdate('android', installed, policy)).toBeNull();
  }
});

it('fails open on network errors, HTTP failure and malformed JSON; never fetches on web', async () => {
  const request = vi.fn().mockRejectedValue(new Error('offline'));
  expect(await fetchStoreUpdate('https://test', 'android', '0.2.22', request)).toBeNull();
  request.mockResolvedValueOnce(new Response('{}', { status: 503 }));
  expect(await fetchStoreUpdate('https://test', 'android', '0.2.22', request)).toBeNull();
  request.mockResolvedValueOnce(new Response('not JSON'));
  expect(await fetchStoreUpdate('https://test', 'android', '0.2.22', request)).toBeNull();
  request.mockResolvedValueOnce(new Response(JSON.stringify(policy)));
  expect(await fetchStoreUpdate('https://test', 'android', '0.2.22', request)).toEqual(minimum);
  request.mockClear();
  expect(await fetchStoreUpdate('https://test', 'web', '0.1.0', request)).toBeNull();
  expect(request).not.toHaveBeenCalled();
});

it('abandons an unreachable server after the bounded deadline', async () => {
  vi.useFakeTimers();
  try {
    const request = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const result = fetchStoreUpdate('https://test', 'android', '0.2.22', request);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toBeNull();
    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
