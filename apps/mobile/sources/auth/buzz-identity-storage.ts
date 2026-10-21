/**
 * Buzz identity access — the signed-in identity comes from the monolith
 * session; device storage keeps only the pending GitHub candidate key and
 * clears the retired device key on sign-out.
 *
 * Web build (browser and Tauri): localStorage. Native: expo-secure-store.
 */

import {
  loadIdentityFromNsec,
  identityNpub,
  type Identity,
} from '@beeline/buzz-client';
import * as SecureStore from 'expo-secure-store';
import { getBuzzRuntimeConfig } from '@/buzz/runtime-config';
import { monolithSession } from '@/auth/monolith-session';
import { webStringStorage, type BrowserStringStorage } from '@/sync/browser-string-storage';
import { webRuntimeStorage } from '@/utils/web-storage';

// SecureStore on Android requires keys matching [A-Za-z0-9._-]+
const BUZZ_NSEC_KEY = 'buzzy.identity.nsec';
const PENDING_GITHUB_NSEC_KEY = 'buzzy.identity.githubPendingNsec';

const NSEC_STORAGE_OPTIONS: SecureStore.SecureStoreOptions = {
  // Keep identity secrets available only while this device is unlocked and
  // prevent iOS backups from migrating them to another device.
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/**
 * The web build (browser and Tauri) keeps identity in the origin's storage,
 * or in memory for this page where the browser denies storage. Native uses
 * SecureStore.
 */
function webStore(): BrowserStringStorage | null {
  const web = webRuntimeStorage();
  return web ? webStringStorage(web.storage) : null;
}

async function secretGetAt(key: string): Promise<string | null> {
  const web = webStore();
  if (web) return web.getString(key) ?? null;
  return SecureStore.getItemAsync(key, NSEC_STORAGE_OPTIONS);
}

async function secretRemoveAt(key: string): Promise<void> {
  const web = webStore();
  if (web) {
    web.delete(key);
    return;
  }
  await SecureStore.deleteItemAsync(key, NSEC_STORAGE_OPTIONS);
}

async function secretRemove(): Promise<void> {
  await secretRemoveAt(BUZZ_NSEC_KEY);
}

/** A warm cache may render synchronously only for the current in-memory account. */
export function peekBuzzViewerContext(): { relayUrl: string; viewerPubkey: string } | null {
  const runtime = getBuzzRuntimeConfig();
  const viewerPubkey = monolithSession.peekIdentityId();
  return viewerPubkey ? { relayUrl: runtime.monolithUrl, viewerPubkey } : null;
}

/** Viewer pubkey for cache/addressing. Does not wait on token refresh. */
export async function loadBuzzViewerPubkey(): Promise<string | null> {
  return monolithSession.identityId();
}

/**
 * Load the device's signed-in identity without contacting the server. A token
 * renewal can fail while offline, asleep or during a deploy; that is a read
 * failure, never evidence that the person signed out. Authenticated operations
 * renew their own access token through MonolithSession.
 */
export async function loadBuzzIdentity(): Promise<Identity | null> {
  const identityId = await monolithSession.identityId();
  if (!identityId) return null;
  return { publicKey: identityId, secretKey: new Uint8Array() };
}

/** The OAuth candidate key, kept across deep-link remounts and process death. */
export async function loadPendingGitHubIdentity(): Promise<Identity | null> {
  const nsec = await secretGetAt(PENDING_GITHUB_NSEC_KEY);
  return nsec ? loadIdentityFromNsec(nsec, 'buzzy-mobile') : null;
}

export async function clearPendingGitHubIdentity(): Promise<void> {
  await secretRemoveAt(PENDING_GITHUB_NSEC_KEY);
}

/** Forget the stored identity (logout). */
export async function clearBuzzIdentity(): Promise<void> {
  await Promise.all([secretRemove(), secretRemoveAt(PENDING_GITHUB_NSEC_KEY)]);
}

/** The server origin every Room and Workspace surface reads from. */
export async function getEffectiveRelayUrl(): Promise<string> {
  return getBuzzRuntimeConfig().monolithUrl;
}

export { identityNpub };
