import AsyncStorage from '@react-native-async-storage/async-storage';
import { nip98AuthHeader } from '@beeline/nostr';
import type { Identity } from '@beeline/buzz-client';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import * as Updates from 'expo-updates';
import { Platform } from 'react-native';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';

const DEVICE_ID_KEY = '@beeline/mobile-update-receipt/device-id';
const RECEIPT_TIMEOUT_MS = 7_500;
let deviceIdPromise: Promise<string> | null = null;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** EAS exposes the update group in manifest metadata on current OTA manifests. */
export function runningUpdateGroup(manifest: unknown): string | null {
  const root = object(manifest);
  const metadata = object(root?.metadata);
  const extra = object(root?.extra);
  const eas = object(extra?.eas);
  return (
    string(metadata?.updateGroup) ??
    string(root?.updateGroup) ??
    string(eas?.updateGroup) ??
    null
  );
}

async function installationDeviceId(): Promise<string> {
  deviceIdPromise ??= (async () => {
    try {
      const existing = await AsyncStorage.getItem(DEVICE_ID_KEY);
      if (existing) return existing;
      const created = Crypto.randomUUID();
      await AsyncStorage.setItem(DEVICE_ID_KEY, created);
      return created;
    } catch (error) {
      deviceIdPromise = null;
      throw error;
    }
  })();
  return deviceIdPromise;
}

/**
 * Report the bytes this installation is actually running. This is independent
 * of notification permission and FCM registration, so a push-disabled owner
 * device can still close the OTA delivery loop.
 */
export async function reportRunningUpdateReceipt(identity: Identity): Promise<void> {
  if (!['android', 'ios'].includes(Platform.OS)) return;
  const receiptUrl = `${getBuzzRuntimeConfig().pushGatewayUrl}/update-receipts`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RECEIPT_TIMEOUT_MS);
  try {
    const response = await fetch(receiptUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: nip98AuthHeader(
          identity.secretKey,
          identity.publicKey,
          receiptUrl,
          'POST',
        ),
      },
      body: JSON.stringify({
        pubkey: identity.publicKey,
        deviceId: await installationDeviceId(),
        updateId: Updates.updateId ?? null,
        channel: Updates.channel ?? null,
        group: runningUpdateGroup(Updates.manifest),
        runtimeVersion: Updates.runtimeVersion ?? null,
        environment: Device.isDevice ? 'physical' : 'emulator',
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`gateway returned HTTP ${response.status}`);
    console.log(
      `[buzzy-ota] running update reported update=${Updates.updateId ?? 'embedded'} channel=${Updates.channel ?? 'embedded'}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}
