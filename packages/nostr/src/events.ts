import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

/** A Nostr event (NIP-01) before it has been hashed and signed. */
export interface UnsignedEvent {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

/** A signed Nostr event. */
export interface NostrEvent extends UnsignedEvent {
  id: string;
  sig: string;
}

/** NIP-01 canonical serialization used to derive an event's id. */
function serializeEvent(event: UnsignedEvent): string {
  return JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
}

/** Compute an event's id: the hex sha256 of its canonical serialization. */
export function getEventHash(event: UnsignedEvent): string {
  return bytesToHex(sha256(new TextEncoder().encode(serializeEvent(event))));
}

/** Sign an event with a secret key, producing its id and BIP-340 signature. */
export function signEvent(event: UnsignedEvent, secretKey: Uint8Array): NostrEvent {
  const id = getEventHash(event);
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), secretKey));
  return { ...event, id, sig };
}

/**
 * Verify a signed event: its id must match its content, and its signature
 * must be a valid BIP-340 schnorr signature over that id by `event.pubkey`.
 */
export function verifyEvent(event: NostrEvent): boolean {
  if (getEventHash(event) !== event.id) {
    return false;
  }
  try {
    return schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey));
  } catch {
    return false;
  }
}
