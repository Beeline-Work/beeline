import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearWebPushSubscription,
  registerWebPush,
  unregisterWebPush,
} from './web-push-registration';

const operation = vi.hoisted(() => vi.fn());
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: operation }));

const identity = { publicKey: 'person-1' } as never;
const endpoint = 'https://fcm.googleapis.com/fcm/send/browser';
const keys = { p256dh: 'a'.repeat(87), auth: 'b'.repeat(22) };

describe('Chrome push registration', () => {
  let subscription: {
    endpoint: string;
    toJSON: () => { keys: typeof keys };
    unsubscribe: ReturnType<typeof vi.fn>;
  } | null;
  const subscribe = vi.fn();
  const requestPermission = vi.fn();
  const local = new Map<string, string>();

  beforeEach(() => {
    vi.clearAllMocks();
    local.clear();
    subscription = null;
    const pushManager = {
      getSubscription: vi.fn(async () => subscription),
      subscribe: subscribe.mockImplementation(async () => {
        subscription = { endpoint, toJSON: () => ({ keys }), unsubscribe: vi.fn(async () => true) };
        return subscription;
      }),
    };
    const registration = { pushManager };
    vi.stubGlobal('window', {
      isSecureContext: true,
      PushManager: function () {},
      Notification: function () {},
    });
    vi.stubGlobal('PushManager', function () {});
    vi.stubGlobal('navigator', {
      serviceWorker: {
        register: vi.fn(async () => registration),
        getRegistration: vi.fn(async () => registration),
      },
    });
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => local.get(key) ?? null,
      setItem: (key: string, value: string) => local.set(key, value),
      removeItem: (key: string) => local.delete(key),
    });
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission });
    operation.mockImplementation(async (name: string) =>
      name === 'readWebPushKey' ? { publicKey: 'c'.repeat(87) } : { accepted: true },
    );
  });

  it('subscribes and binds the endpoint and keys through the authenticated operation', async () => {
    expect(await registerWebPush(identity, false)).toMatchObject({ registered: true });
    expect(subscribe).toHaveBeenCalledOnce();
    expect(operation).toHaveBeenCalledWith('registerPushDevice', {
      token: endpoint,
      platform: 'web',
      environment: 'physical',
      keys,
    });
    expect(local.get('@beeline/web-push/owner')).toBe('person-1');
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('does not prompt automatically, and drops the endpoint on opt-out', async () => {
    vi.stubGlobal('Notification', { permission: 'default', requestPermission });
    expect(await registerWebPush(identity, false)).toMatchObject({ phase: 'permission-denied' });
    expect(requestPermission).not.toHaveBeenCalled();
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission });
    await registerWebPush(identity, false);
    const old = subscription!;
    await unregisterWebPush();
    expect(operation).toHaveBeenCalledWith('unregisterPushDevice', {
      token: endpoint,
      platform: 'web',
      environment: 'physical',
    });
    expect(old.unsubscribe).toHaveBeenCalledOnce();
    await clearWebPushSubscription();
  });

  it('replaces a subscription that belongs to another signed-in person', async () => {
    await registerWebPush(identity, false);
    const old = subscription!;
    await registerWebPush({ publicKey: 'person-2' } as never, false);
    expect(old.unsubscribe).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(local.get('@beeline/web-push/owner')).toBe('person-2');
  });
});
