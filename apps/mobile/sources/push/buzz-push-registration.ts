import AsyncStorage from '@react-native-async-storage/async-storage';
import { nip98AuthHeader } from '@beeline/nostr';
import type { Identity } from '@beeline/buzz-client';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';

const REGISTRATION_TIMEOUT_MS = 7_500;
const PUSH_ENABLED_PREFIX = '@beeline/buzz-push/enabled/';
const PUSH_TOKEN_PREFIX = '@beeline/buzz-push/token/';

function enabledKey(pubkey: string): string {
  return `${PUSH_ENABLED_PREFIX}${pubkey}`;
}

function tokenKey(pubkey: string): string {
  return `${PUSH_TOKEN_PREFIX}${pubkey}`;
}

export async function getBuzzPushEnabled(pubkey: string): Promise<boolean> {
  return (await AsyncStorage.getItem(enabledKey(pubkey))) !== '0';
}

async function withRegistrationTimeout<T>(operation: Promise<T>, description: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${description} timed out after ${REGISTRATION_TIMEOUT_MS}ms`)),
          REGISTRATION_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

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
  if (!(await getBuzzPushEnabled(identity.publicKey))) return false;

  try {
    if (!(await grantedAndroidNotificationPermission())) return false;

    const nativeToken = await withRegistrationTimeout(
      Notifications.getDevicePushTokenAsync(),
      'FCM token acquisition',
    );
    // Expo identifies native tokens by platform; on Android the string is the
    // raw FCM registration token consumed by Firebase Admin.
    if (nativeToken.type !== 'android' || typeof nativeToken.data !== 'string') {
      console.warn('[buzzy-push] Android did not return an FCM token');
      return false;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REGISTRATION_TIMEOUT_MS);
    try {
      const registrationUrl = `${getBuzzRuntimeConfig().pushGatewayUrl}/registrations`;
      const response = await fetch(registrationUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: nip98AuthHeader(
            identity.secretKey,
            identity.publicKey,
            registrationUrl,
            'POST',
          ),
        },
        body: JSON.stringify({
          pubkey: identity.publicKey,
          token: nativeToken.data,
          platform: 'android',
          environment: Device.isDevice ? 'physical' : 'emulator',
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`gateway returned HTTP ${response.status}`);
      }
      if (response.status === 202) {
        console.log('[buzzy-push] non-production FCM device ignored');
        return false;
      }
      await AsyncStorage.setItem(tokenKey(identity.publicKey), nativeToken.data);
    } finally {
      clearTimeout(timeout);
    }

    console.log('[buzzy-push] FCM device registered');
    return true;
  } catch (error) {
    console.warn(
      '[buzzy-push] FCM registration unavailable:',
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

export async function setBuzzPushEnabled(identity: Identity, enabled: boolean): Promise<boolean> {
  await AsyncStorage.setItem(enabledKey(identity.publicKey), enabled ? '1' : '0');
  if (enabled) return registerBuzzPushNotifications(identity);

  let token = await AsyncStorage.getItem(tokenKey(identity.publicKey));
  if (!token && Platform.OS === 'android') {
    try {
      const permission = await Notifications.getPermissionsAsync();
      if (permission.granted) {
        const current = await Notifications.getDevicePushTokenAsync();
        if (current.type === 'android' && typeof current.data === 'string') token = current.data;
      }
    } catch {
      // A device without configured FCM cannot have completed registration.
      // Keep the local opt-out instead of making the switch appear stuck on.
      return false;
    }
  }
  if (!token) return false;
  const registrationUrl = `${getBuzzRuntimeConfig().pushGatewayUrl}/registrations`;
  const response = await fetch(registrationUrl, {
    method: 'DELETE',
    headers: {
      'content-type': 'application/json',
      authorization: nip98AuthHeader(
        identity.secretKey,
        identity.publicKey,
        registrationUrl,
        'DELETE',
      ),
    },
    body: JSON.stringify({ pubkey: identity.publicKey, token }),
  });
  if (!response.ok) throw new Error(`gateway returned HTTP ${response.status}`);
  await AsyncStorage.removeItem(tokenKey(identity.publicKey));
  return false;
}
