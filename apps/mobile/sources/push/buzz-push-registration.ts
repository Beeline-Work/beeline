import type { Identity } from '@buzzy/buzz-client';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';

const REGISTRATION_TIMEOUT_MS = 7_500;

async function grantedAndroidNotificationPermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  return (await Notifications.requestPermissionsAsync()).granted;
}

/**
 * Obtain the native Android push token (FCM) and bind it to the Buzz pubkey.
 * Registration failures do not block login; the app retries on the next login.
 */
export async function registerBuzzPushNotifications(identity: Identity): Promise<boolean> {
  if (Platform.OS !== 'android') return false;

  try {
    if (!(await grantedAndroidNotificationPermission())) return false;

    const nativeToken = await Notifications.getDevicePushTokenAsync();
    // Expo identifies native tokens by platform; on Android the string is the
    // raw FCM registration token consumed by Firebase Admin.
    if (nativeToken.type !== 'android' || typeof nativeToken.data !== 'string') {
      console.warn('[buzzy-push] Android did not return an FCM token');
      return false;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REGISTRATION_TIMEOUT_MS);
    try {
      const response = await fetch(`${getBuzzRuntimeConfig().pushGatewayUrl}/registrations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          pubkey: identity.publicKey,
          token: nativeToken.data,
          platform: 'android',
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`gateway returned HTTP ${response.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }

    console.log('[buzzy-push] FCM device registered');
    return true;
  } catch (error) {
    console.warn('[buzzy-push] FCM registration unavailable:', error instanceof Error ? error.message : String(error));
    return false;
  }
}
