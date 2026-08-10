/**
 * Identity helpers — create/load nsec, npub encode.
 * Crypto is entirely @beeline/nostr (BIP-340 + NIP-19).
 */
import {
  generateKeypair,
  getPublicKey,
  encodeNpub,
  encodeNsec,
  decodeNsec,
  decodeNpub,
} from '@beeline/nostr';
import type { AgentIdentity, Identity } from './types.js';

/** Create a fresh identity (new random nsec). */
export function createIdentity(name?: string): Identity {
  const kp = generateKeypair();
  return name ? { ...kp, name } : kp;
}

/** Create a keypair explicitly reserved for an agent entity. */
export function createAgentIdentity(name = 'Agent'): AgentIdentity {
  return { ...createIdentity(), name, entityType: 'agent' };
}

/** Load an identity from a bech32 `nsec1…` string. */
export function loadIdentityFromNsec(nsec: string, name?: string): Identity {
  const secretKey = decodeNsec(nsec);
  const publicKey = getPublicKey(secretKey);
  return name ? { secretKey, publicKey, name } : { secretKey, publicKey };
}

/** Restore an agent identity from nsec without collapsing it into a human identity. */
export function loadAgentIdentityFromNsec(nsec: string, name = 'Agent'): AgentIdentity {
  return { ...loadIdentityFromNsec(nsec), name, entityType: 'agent' };
}

/** Load from raw 32-byte secret key. */
export function loadIdentityFromSecret(secretKey: Uint8Array, name?: string): Identity {
  const publicKey = getPublicKey(secretKey);
  return name ? { secretKey, publicKey, name } : { secretKey, publicKey };
}

/** Restore an agent identity from raw secret bytes. */
export function loadAgentIdentityFromSecret(secretKey: Uint8Array, name = 'Agent'): AgentIdentity {
  return { ...loadIdentityFromSecret(secretKey), name, entityType: 'agent' };
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
