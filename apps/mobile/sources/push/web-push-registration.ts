import type { Identity } from '@beeline/buzz-client';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import type { BuzzPushRegistrationResult } from './buzz-push-registration';

const WORKER_PATH = '/push-sw.js';
const OWNER_KEY = '@beeline/web-push/owner';

function supported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    window.isSecureContext
  );
}

function applicationKey(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(
    value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4),
  );
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function worker(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register(WORKER_PATH, { scope: '/' });
}

/** Called on logout before another signed-in person can inherit this browser endpoint. */
export async function clearWebPushSubscription(): Promise<void> {
  if (!supported()) return;
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager.getSubscription();
  await subscription?.unsubscribe();
  localStorage.removeItem(OWNER_KEY);
}

export async function unregisterWebPush(): Promise<void> {
  if (!supported()) return;
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription) {
    try {
      await monolithPhoneOperation('unregisterPushDevice', {
        token: subscription.endpoint,
        platform: 'web',
        environment: 'physical',
      });
    } catch {
      // The browser endpoint is invalid once unsubscribed; the server removes
      // a stale row after its next 404/410 delivery attempt.
    } finally {
      await clearWebPushSubscription();
    }
    return;
  }
  await clearWebPushSubscription();
}

export async function registerWebPush(
  identity: Identity,
  requestPermission: boolean,
): Promise<BuzzPushRegistrationResult> {
  if (!supported()) return { registered: false, retryable: false, phase: 'unsupported-platform' };
  try {
    if (Notification.permission === 'default' && requestPermission)
      await Notification.requestPermission();
    if (Notification.permission !== 'granted')
      return { registered: false, retryable: true, phase: 'permission-denied' };
    const { publicKey } = await monolithPhoneOperation('readWebPushKey', {});
    if (!publicKey)
      return {
        registered: false,
        retryable: true,
        phase: 'gateway-rejected',
        message: 'web push is not configured',
      };
    const registration = await worker();
    let subscription = await registration.pushManager.getSubscription();
    const priorOwner = localStorage.getItem(OWNER_KEY);
    const expectedKey = applicationKey(publicKey);
    const existingKey = subscription?.options?.applicationServerKey;
    const keyChanged =
      existingKey &&
      (existingKey.byteLength !== expectedKey.byteLength ||
        new Uint8Array(existingKey).some((byte, index) => byte !== expectedKey[index]));
    if (subscription && ((priorOwner && priorOwner !== identity.publicKey) || keyChanged)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    if (!subscription)
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: expectedKey,
      });
    const keys = subscription.toJSON().keys;
    if (!keys?.p256dh || !keys.auth) throw new Error('browser returned no subscription keys');
    await monolithPhoneOperation('registerPushDevice', {
      token: subscription.endpoint,
      platform: 'web',
      environment: 'physical',
      keys: { p256dh: keys.p256dh, auth: keys.auth },
    });
    localStorage.setItem(OWNER_KEY, identity.publicKey);
    return { registered: true, retryable: false, phase: 'registered' };
  } catch {
    // Subscription endpoints and keys are secrets; never include vendor errors in UI or logs.
    return { registered: false, retryable: true, phase: 'network-failed' };
  }
}
