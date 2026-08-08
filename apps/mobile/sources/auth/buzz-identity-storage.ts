/**
 * Buzz identity persistence — store/load nsec from device storage.
 *
 * Web: localStorage. Native: expo-secure-store (dynamic import, graceful fallback).
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
} from '@buzzy/buzz-client';

const BUZZ_NSEC_KEY = '@buzzy/identity/nsec';
const BUZZ_RELAY_URL_KEY = '@buzzy/identity/relayUrl';

const DEFAULT_RELAY_URL = 'https://buzz.trustysquire.ai';

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
  // Dynamic require for expo-secure-store — type declarations unavailable in this config.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const SecureStore = require('expo-secure-store') as {
      getItemAsync: (k: string) => Promise<string | null>;
      setItemAsync: (k: string, v: string) => Promise<void>;
      deleteItemAsync: (k: string) => Promise<void>;
    };
    return SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

async function storageSet(key: string, value: string): Promise<void> {
  if (isWeb()) {
    localStorage.setItem(key, value);
    return;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const SecureStore = require('expo-secure-store') as {
      getItemAsync: (k: string) => Promise<string | null>;
      setItemAsync: (k: string, v: string) => Promise<void>;
      deleteItemAsync: (k: string) => Promise<void>;
    };
    await SecureStore.setItemAsync(key, value);
  } catch {
    // Ignore — storage may be unavailable
  }
}

async function storageRemove(key: string): Promise<void> {
  if (isWeb()) {
    localStorage.removeItem(key);
    return;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const SecureStore = require('expo-secure-store') as {
      getItemAsync: (k: string) => Promise<string | null>;
      setItemAsync: (k: string, v: string) => Promise<void>;
      deleteItemAsync: (k: string) => Promise<void>;
    };
    await SecureStore.deleteItemAsync(key);
  } catch {
    // Ignore
  }
}

/** Load the stored Buzz identity (null if never set). */
export async function loadBuzzIdentity(): Promise<Identity | null> {
  try {
    const nsec = await storageGet(BUZZ_NSEC_KEY);
    if (!nsec) return null;
    return loadIdentityFromNsec(nsec);
  } catch (err) {
    console.warn('Failed to load Buzz identity:', err);
    return null;
  }
}

/** Persist an identity for next launch. */
export async function saveBuzzIdentity(identity: Identity): Promise<void> {
  const nsec = identityNsec(identity);
  await storageSet(BUZZ_NSEC_KEY, nsec);
}

/** Forget the stored identity (logout). */
export async function clearBuzzIdentity(): Promise<void> {
  await storageRemove(BUZZ_NSEC_KEY);
}

/** Generate a fresh keypair and persist it, returning the identity. */
export async function generateBuzzIdentity(): Promise<Identity> {
  const identity = createIdentity('buzzy-mobile');
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
  try {
    return await storageGet(BUZZ_RELAY_URL_KEY);
  } catch (err) {
    console.warn('Failed to load relay URL:', err);
    return null;
  }
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