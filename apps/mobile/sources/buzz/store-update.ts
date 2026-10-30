import { parseMobileMinimum, storeVersionBelow, type MobileMinimum } from '@beeline/api-contract/mobile-minimum';

export function requiredStoreUpdate(platform: string, nativeVersion: string | null, policy: unknown): MobileMinimum | null {
  if ((platform !== 'android' && platform !== 'ios') || !policy || typeof policy !== 'object') return null;
  const minimum = parseMobileMinimum((policy as Record<string, unknown>)[platform]);
  return minimum && storeVersionBelow(nativeVersion, minimum.minVersion) ? minimum : null;
}

export async function fetchStoreUpdate(baseUrl: string, platform: string, nativeVersion: string | null,
  request: typeof fetch = fetch): Promise<MobileMinimum | null> {
  if (platform !== 'android' && platform !== 'ios') return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await request(`${baseUrl.replace(/\/$/, '')}/v1/public/mobile-minimum`, { signal: controller.signal });
    return response.ok ? requiredStoreUpdate(platform, nativeVersion, await response.json()) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export const STORE_LISTINGS = {
  android: 'https://play.google.com/store/apps/details?id=app.usebeeline',
  ios: 'https://apps.apple.com/app/id6803948500',
} as const;
