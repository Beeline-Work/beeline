/**
 * Buzz identity persistence — store/load nsec from device storage.
 *
 * Web: localStorage. Native: expo-secure-store.
 *
 * This is the "minimal acceptable onboarding" per spec.md — generate a key
 * or paste an nsec1… string, then stash it so the app boots into the channel
 * list on subsequent launches.
 */

import {
  createIdentity,
  loadIdentityFromNsec,
  identityNsec,
  identityNpub,
  type Identity,
} from '@beeline/buzz-client';
import * as SecureStore from 'expo-secure-store';

// SecureStore on Android requires keys matching [A-Za-z0-9._-]+
const BUZZ_NSEC_KEY = 'buzzy.identity.nsec';
const BUZZ_RELAY_URL_KEY = 'buzzy.identity.relayUrl';

const NSEC_STORAGE_OPTIONS: SecureStore.SecureStoreOptions = {
  // Keep identity secrets available only while this device is unlocked and
  // prevent iOS backups from migrating them to another device.
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export const DEFAULT_RELAY_URL = 'https://buzz.trustysquire.ai';

function isWeb(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.document !== 'undefined'
  );
}

async function storageGet(key: string): Promise<string | null> {
  if (isWeb()) {
    return localStorage.getItem(key);
  }
  return SecureStore.getItemAsync(key);
}

async function storageSet(key: string, value: string): Promise<void> {
  if (isWeb()) {
    localStorage.setItem(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

async function storageRemove(key: string): Promise<void> {
  if (isWeb()) {
    localStorage.removeItem(key);
    return;
  }
  await SecureStore.deleteItemAsync(key);
}

async function secretGet(): Promise<string | null> {
  if (isWeb()) {
    return localStorage.getItem(BUZZ_NSEC_KEY);
  }
  return SecureStore.getItemAsync(BUZZ_NSEC_KEY, NSEC_STORAGE_OPTIONS);
}

async function secretSet(value: string): Promise<void> {
  if (isWeb()) {
    localStorage.setItem(BUZZ_NSEC_KEY, value);
    return;
  }
  await SecureStore.setItemAsync(BUZZ_NSEC_KEY, value, NSEC_STORAGE_OPTIONS);
}

async function secretRemove(): Promise<void> {
  if (isWeb()) {
    localStorage.removeItem(BUZZ_NSEC_KEY);
    return;
  }
  await SecureStore.deleteItemAsync(BUZZ_NSEC_KEY, NSEC_STORAGE_OPTIONS);
}

/** Load the stored Buzz identity (null if never set). */
export async function loadBuzzIdentity(): Promise<Identity | null> {
  const nsec = await secretGet();
  if (!nsec) return null;
  return loadIdentityFromNsec(nsec);
}

/**
 * Read the stored secret for an explicit, locally-confirmed export flow.
 * Callers must gate this behind user authentication before invoking it.
 */
export async function loadBuzzIdentityNsecForExport(): Promise<string | null> {
  return secretGet();
}

/** Persist an identity for next launch. */
export async function saveBuzzIdentity(identity: Identity): Promise<void> {
  const nsec = identityNsec(identity);
  await secretSet(nsec);
}

/** Forget the stored identity (logout). */
export async function clearBuzzIdentity(): Promise<void> {
  await secretRemove();
}

/** Generate a fresh keypair and persist it, returning the identity. */
export async function generateBuzzIdentity(name = 'buzzy-mobile'): Promise<Identity> {
  const identity = createIdentity(name.trim() || 'buzzy-mobile');
  await saveBuzzIdentity(identity);
  return identity;
}

/** Import an nsec1… string, derive identity, persist, and return it. */
export async function importBuzzIdentity(nsec: string): Promise<Identity> {
  const identity = loadIdentityFromNsec(nsec, 'buzzy-mobile');
  await saveBuzzIdentity(identity);
  return identity;
}

/** Load the stored relay URL (null if never set). */
export async function loadRelayUrl(): Promise<string | null> {
  return storageGet(BUZZ_RELAY_URL_KEY);
}

/** Persist a relay URL for next launch. */
export async function saveRelayUrl(url: string): Promise<void> {
  await storageSet(BUZZ_RELAY_URL_KEY, url);
}

/** Forget the stored relay URL (reset to default). */
export async function clearRelayUrl(): Promise<void> {
  await storageRemove(BUZZ_RELAY_URL_KEY);
}

/**
 * Load the relay URL with a sensible default.
 * Returns the stored URL, falling back to DEFAULT_RELAY_URL.
 */
export async function getEffectiveRelayUrl(): Promise<string> {
  const stored = await loadRelayUrl();
  return stored ?? DEFAULT_RELAY_URL;
}

export { identityNpub };
