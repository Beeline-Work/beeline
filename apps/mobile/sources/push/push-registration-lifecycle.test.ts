import { describe, expect, it, vi } from 'vitest';
import type { Identity } from '@beeline/buzz-client';
import { startPushRegistrationLifecycle } from './push-registration-lifecycle';

const person = (publicKey: string) =>
  ({ publicKey, secretKey: new Uint8Array(32), name: publicKey }) as Identity;
const success = { registered: true, retryable: false, phase: 'registered' as const };

function setup(initial: Identity | null = null) {
  let identity = initial;
  let changed = () => {};
  let foreground = () => {};
  const register = vi.fn(async (_identity: Identity) => success);
  const retry = vi.fn(async (_identity: Identity) => null);
  const loadIdentity = vi.fn(async () => identity);
  const stopIdentity = vi.fn();
  const stopForeground = vi.fn();
  const dispose = startPushRegistrationLifecycle({
    loadIdentity,
    register,
    retry,
    reportUpdate: vi.fn(async () => undefined),
    reportFailure: vi.fn(),
    subscribeIdentityChange: (listener) => {
      changed = listener;
      return stopIdentity;
    },
    subscribeForeground: (listener) => {
      foreground = listener;
      return stopForeground;
    },
  });
  return {
    register,
    retry,
    loadIdentity,
    dispose,
    stopIdentity,
    stopForeground,
    foreground: () => foreground(),
    signIn: (next: Identity | null) => {
      identity = next;
      changed();
    },
  };
}

describe('push registration follows the signed-in identity', () => {
  it('registers a sign-in after an empty mount without a restart or foreground event', async () => {
    const app = setup();
    await vi.waitFor(() => expect(app.loadIdentity).toHaveBeenCalledOnce());
    expect(app.register).not.toHaveBeenCalled();
    const first = person('first');
    app.signIn(first);
    await vi.waitFor(() => expect(app.register).toHaveBeenCalledWith(first));
    const second = person('second');
    app.signIn(second);
    await vi.waitFor(() => expect(app.register).toHaveBeenLastCalledWith(second));
    expect(app.register).toHaveBeenCalledTimes(2);
    app.dispose();
  });

  it('refreshes on cold start, retries the current identity on foreground and stops on sign-out', async () => {
    const first = person('first');
    const app = setup(first);
    await vi.waitFor(() => expect(app.register).toHaveBeenCalledOnce());
    app.foreground();
    await vi.waitFor(() => expect(app.retry).toHaveBeenCalledWith(first));
    app.signIn(null);
    await vi.waitFor(() => expect(app.loadIdentity).toHaveBeenCalledTimes(3));
    app.foreground();
    await vi.waitFor(() => expect(app.loadIdentity).toHaveBeenCalledTimes(4));
    expect(app.retry).toHaveBeenCalledOnce();
    app.dispose();
    app.signIn(person('after-unmount'));
    expect(app.register).toHaveBeenCalledOnce();
    expect(app.stopIdentity).toHaveBeenCalledOnce();
    expect(app.stopForeground).toHaveBeenCalledOnce();
  });

  it('does not lose an account change while the previous registration is pending', async () => {
    const app = setup();
    let finish!: (value: typeof success) => void;
    app.register.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    app.signIn(person('first'));
    await vi.waitFor(() => expect(app.register).toHaveBeenCalledOnce());
    const second = person('second');
    app.signIn(second);
    app.foreground();
    finish(success);
    await vi.waitFor(() => expect(app.register).toHaveBeenLastCalledWith(second));
    app.dispose();
  });
});
