/**
 * Identity helpers — create/load nsec, npub encode.
 * Crypto is entirely @buzzy/nostr (BIP-340 + NIP-19).
 */
import {
  generateKeypair,
  getPublicKey,
  encodeNpub,
  encodeNsec,
  decodeNsec,
  decodeNpub,
} from '@buzzy/nostr';
import type { Identity } from './types.js';

/** Create a fresh identity (new random nsec). */
export function createIdentity(name?: string): Identity {
  const kp = generateKeypair();
  return name ? { ...kp, name } : kp;
}

/** Load an identity from a bech32 `nsec1…` string. */
export function loadIdentityFromNsec(nsec: string, name?: string): Identity {
  const secretKey = decodeNsec(nsec);
  const publicKey = getPublicKey(secretKey);
  return name ? { secretKey, publicKey, name } : { secretKey, publicKey };
}

/** Load from raw 32-byte secret key. */
export function loadIdentityFromSecret(secretKey: Uint8Array, name?: string): Identity {
  const publicKey = getPublicKey(secretKey);
  return name ? { secretKey, publicKey, name } : { secretKey, publicKey };
}

/** Encode identity pubkey as `npub1…`. */
export function identityNpub(identity: Identity): string {
  return encodeNpub(identity.publicKey);
}

/** Encode identity secret as `nsec1…` (sensitive — only for storage/export). */
export function identityNsec(identity: Identity): string {
  return encodeNsec(identity.secretKey);
}

export { encodeNpub, encodeNsec, decodeNpub, decodeNsec, getPublicKey };
