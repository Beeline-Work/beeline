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
const PUSH_REGISTRATION_PREFIX = '@beeline/buzz-push/registration/';

/** Automatic foreground retries back off exponentially from this base. */
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;

export type BuzzPushRegistrationPhase =
  | 'registered'
  | 'disabled'
  | 'unsupported-platform'
  | 'permission-denied'
  | 'token-type-unexpected'
  | 'token-timed-out'
  | 'token-failed'
  | 'registration-timed-out'
  | 'gateway-rejected'
  | 'network-failed';

export interface BuzzPushRegistrationResult {
  registered: boolean;
  /** A later launch or foreground should retry this automatically. */
  retryable: boolean;
  phase: BuzzPushRegistrationPhase;
  message?: string;
}

/**
 * Durable record of the last registration attempt, so the settings UI can tell
 * the truth about whether a device token is actually bound to the gateway
 * rather than merely whether the user asked for push.
 */
export interface BuzzPushRegistrationState extends BuzzPushRegistrationResult {
  failedAttempts: number;
  updatedAt: number;
}

class RegistrationTimeoutError extends Error {
  constructor(description: string) {
    super(`${description} timed out after ${REGISTRATION_TIMEOUT_MS}ms`);
    this.name = 'RegistrationTimeoutError';
  }
}

function enabledKey(pubkey: string): string {
  return `${PUSH_ENABLED_PREFIX}${pubkey}`;
}

function tokenKey(pubkey: string): string {
  return `${PUSH_TOKEN_PREFIX}${pubkey}`;
}

function registrationKey(pubkey: string): string {
  return `${PUSH_REGISTRATION_PREFIX}${pubkey}`;
}

/**
 * Short non-reversible fingerprint of a push token for diagnostics ONLY.
 * Never log or surface the full FCM token.
 */
function tokenFingerprint(token: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export async function getBuzzPushEnabled(pubkey: string): Promise<boolean> {
  return (await AsyncStorage.getItem(enabledKey(pubkey))) !== '0';
}

export async function getBuzzPushRegistrationState(
  pubkey: string,
): Promise<BuzzPushRegistrationState | null> {
  const raw = await AsyncStorage.getItem(registrationKey(pubkey));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as BuzzPushRegistrationState;
    if (typeof parsed.registered !== 'boolean' || typeof parsed.phase !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function saveRegistrationState(
  pubkey: string,
  state: BuzzPushRegistrationState,
): Promise<void> {
  await AsyncStorage.setItem(registrationKey(pubkey), JSON.stringify(state));
}

function nextRetryDelayMs(failedAttempts: number): number {
  if (failedAttempts <= 1) return 0;
  return Math.min(RETRY_BASE_MS * 2 ** (failedAttempts - 2), RETRY_MAX_MS);
}

async function withRegistrationTimeout<T>(operation: Promise<T>, description: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new RegistrationTimeoutError(description)), REGISTRATION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

interface ClassifiedFailure {
  phase: Exclude<BuzzPushRegistrationPhase, 'registered' | 'disabled' | 'unsupported-platform'>;
  retryable: true;
}

function classifyRegistrationFailure(error: unknown): ClassifiedFailure {
  if (error instanceof RegistrationTimeoutError) {
    return { phase: 'token-timed-out', retryable: true };
  }
  if (isAbortError(error)) {
    return { phase: 'registration-timed-out', retryable: true };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('timed out')) {
    return { phase: 'token-timed-out', retryable: true };
  }
  if (message.startsWith('gateway returned HTTP')) {
    return { phase: 'gateway-rejected', retryable: true };
  }
  return { phase: 'network-failed', retryable: true };
}

async function grantedAndroidNotificationPermission(
  requestWhenPossible: boolean,
): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  console.log(
    `[buzzy-push] permission granted=${current.granted} canAskAgain=${current.canAskAgain} status=${current.status}`,
  );
  if (current.granted) return true;
  if (!current.canAskAgain || !requestWhenPossible) return false;
  const requested = await Notifications.requestPermissionsAsync();
  console.log(
    `[buzzy-push] permission request granted=${requested.granted} canAskAgain=${requested.canAskAgain}`,
  );
  return requested.granted;
}

/**
 * Obtain the native Android push token (FCM) and bind it to the Buzz pubkey.
 * Registration failures do not block login; every attempt is classified,
 * logged under `[buzzy-push]`, persisted for the settings UI, and retried with
 * backoff on later launches / foregrounds when {@link retryable}.
 *
 * Never logs or returns the full FCM token — only a fingerprint and length.
 */
export async function registerBuzzPushNotifications(
  identity: Identity,
  options: { automatic?: boolean } = {},
): Promise<BuzzPushRegistrationResult> {
  if (Platform.OS !== 'android') {
    return { registered: false, retryable: false, phase: 'unsupported-platform' };
  }
  if (!(await getBuzzPushEnabled(identity.publicKey))) {
    return { registered: false, retryable: false, phase: 'disabled' };
  }

  // Automatic retries never prompt for permission; explicit attempts (cold
  // start, toggle on, manual retry) may request it.
  const attempt = await attemptRegistration(identity, !options.automatic);
  const previous = await getBuzzPushRegistrationState(identity.publicKey);
  const state: BuzzPushRegistrationState = attempt.registered
    ? {
        ...attempt,
        failedAttempts: 0,
        updatedAt: Date.now(),
      }
    : {
        ...attempt,
        // Permission gaps are not counted against the backoff: they are cheap
        // to re-check and must not delay a retry once the user grants access.
        failedAttempts:
          attempt.phase === 'permission-denied'
            ? (previous?.failedAttempts ?? 0)
            : (previous?.failedAttempts ?? 0) + 1,
        updatedAt: Date.now(),
      };
  await saveRegistrationState(identity.publicKey, state).catch((error: unknown) => {
    console.warn(
      '[buzzy-push] could not persist registration state:',
      error instanceof Error ? error.message : String(error),
    );
  });
  return state;
}

async function attemptRegistration(
  identity: Identity,
  requestPermission: boolean,
): Promise<BuzzPushRegistrationResult> {
  try {
    if (!(await grantedAndroidNotificationPermission(requestPermission))) {
      return { registered: false, retryable: true, phase: 'permission-denied' };
    }

    let nativeToken: Awaited<ReturnType<typeof Notifications.getDevicePushTokenAsync>>;
    try {
      nativeToken = await withRegistrationTimeout(
        Notifications.getDevicePushTokenAsync(),
        'FCM token acquisition',
      );
    } catch (error) {
      const failure = classifyRegistrationFailure(error);
      console.warn(`[buzzy-push] token acquisition failed phase=${failure.phase}:`, errorMessage(error));
      return { registered: false, retryable: true, phase: failure.phase, message: errorMessage(error) };
    }
    // Expo identifies native tokens by platform; on Android the string is the
    // raw FCM registration token consumed by Firebase Admin.
    if (nativeToken.type !== 'android' || typeof nativeToken.data !== 'string') {
      console.warn('[buzzy-push] Android did not return an FCM token');
      return {
        registered: false,
        retryable: true,
        phase: 'token-type-unexpected',
        message: 'Android did not return an FCM token',
      };
    }
    console.log(
      `[buzzy-push] FCM token acquired fingerprint=${tokenFingerprint(nativeToken.data)} length=${nativeToken.data.length}`,
    );

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
      console.log(`[buzzy-push] POST ${registrationUrl} -> HTTP ${response.status}`);
      if (!response.ok) {
        throw new Error(`gateway returned HTTP ${response.status}`);
      }
      if (response.status === 202) {
        console.log('[buzzy-push] non-production FCM device ignored');
        return {
          registered: false,
          retryable: true,
          phase: 'gateway-rejected',
          message: 'gateway ignored a non-production FCM device (HTTP 202)',
        };
      }
      await AsyncStorage.setItem(tokenKey(identity.publicKey), nativeToken.data);
    } catch (error) {
      const failure = classifyRegistrationFailure(error);
      console.warn(`[buzzy-push] gateway POST failed phase=${failure.phase}:`, errorMessage(error));
      return { registered: false, retryable: true, phase: failure.phase, message: errorMessage(error) };
    } finally {
      clearTimeout(timeout);
    }

    console.log('[buzzy-push] FCM device registered');
    return { registered: true, retryable: false, phase: 'registered' };
  } catch (error) {
    const failure = classifyRegistrationFailure(error);
    console.warn(`[buzzy-push] registration failed phase=${failure.phase}:`, errorMessage(error));
    return { registered: false, retryable: true, phase: failure.phase, message: errorMessage(error) };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Automatic retry on app foreground: only acts when the last attempt left an
 * unregistered-but-retryable state and its backoff window has elapsed. Returns
 * null when there is nothing to retry (two storage reads, no network).
 */
export async function retryBuzzPushRegistration(
  identity: Identity,
): Promise<BuzzPushRegistrationResult | null> {
  if (Platform.OS !== 'android') return null;
  if (!(await getBuzzPushEnabled(identity.publicKey))) return null;
  const state = await getBuzzPushRegistrationState(identity.publicKey);
  if (!state || state.registered || !state.retryable) return null;
  if (Date.now() - state.updatedAt < nextRetryDelayMs(state.failedAttempts)) return null;
  return registerBuzzPushNotifications(identity, { automatic: true });
}

export async function setBuzzPushEnabled(
  identity: Identity,
  enabled: boolean,
): Promise<BuzzPushRegistrationResult> {
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
    }
  }
  const disabledResult: BuzzPushRegistrationResult = {
    registered: false,
    retryable: false,
    phase: 'disabled',
  };
  if (!token) {
    await saveRegistrationState(identity.publicKey, {
      ...disabledResult,
      failedAttempts: 0,
      updatedAt: Date.now(),
    });
    return disabledResult;
  }
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
  await saveRegistrationState(identity.publicKey, {
    ...disabledResult,
    failedAttempts: 0,
    updatedAt: Date.now(),
  });
  return disabledResult;
}
