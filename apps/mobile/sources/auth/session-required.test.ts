import { expect, it, vi } from 'vitest';
import { watchSessionRequired } from './session-required';

it('routes a mounted screen to sign-in after confirmed credential removal, not transient failures', async () => {
  let change!: () => void;
  const identityId = vi.fn().mockResolvedValue('saved-identity');
  const onRequired = vi.fn();
  const stop = watchSessionRequired(onRequired, {
    identityId, subscribeIdentityChange: listener => { change = listener; return vi.fn(); },
  });
  change(); await Promise.resolve();
  expect(onRequired).not.toHaveBeenCalled();
  identityId.mockRejectedValueOnce(new Error('storage unavailable'));
  change(); await Promise.resolve();
  expect(onRequired).not.toHaveBeenCalled();
  identityId.mockResolvedValue(null);
  change(); await Promise.resolve();
  expect(onRequired).toHaveBeenCalledOnce();
  stop();
});

it('ignores a delayed signed-out read after a newer sign-in or unmount', async () => {
  let change!: () => void;
  let resolve!: (identity: string | null) => void;
  const identityId = vi.fn().mockImplementationOnce(() => new Promise(r => { resolve = r; }))
    .mockResolvedValue('new-identity');
  const onRequired = vi.fn();
  const stop = watchSessionRequired(onRequired, {
    identityId, subscribeIdentityChange: listener => { change = listener; return vi.fn(); },
  });
  change(); change(); resolve(null); await Promise.resolve();
  expect(onRequired).not.toHaveBeenCalled();
  identityId.mockResolvedValue(null);
  change(); stop(); await Promise.resolve();
  expect(onRequired).not.toHaveBeenCalled();
});
