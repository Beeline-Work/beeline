import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { nip19 } from 'nostr-tools';

export interface Keypair {
  /** 32-byte secp256k1 secret key. */
  secretKey: Uint8Array;
  /** 32-byte x-only public key, hex-encoded (the Nostr `pubkey` field). */
  publicKey: string;
}

/** Generate a fresh secp256k1/BIP-340 keypair. */
export function generateKeypair(): Keypair {
  const { secretKey, publicKey } = schnorr.keygen();
  return { secretKey, publicKey: bytesToHex(publicKey) };
}

/** Derive the hex x-only public key from a secret key. */
export function getPublicKey(secretKey: Uint8Array): string {
  return bytesToHex(schnorr.getPublicKey(secretKey));
}

/** Encode a hex pubkey as a bech32 `npub1...` string (NIP-19). */
export function encodeNpub(publicKeyHex: string): string {
  return nip19.npubEncode(publicKeyHex);
}

/** Encode a secret key as a bech32 `nsec1...` string (NIP-19). */
export function encodeNsec(secretKey: Uint8Array): string {
  return nip19.nsecEncode(secretKey);
}

/** Decode a bech32 `npub1...` string back to a hex pubkey. */
export function decodeNpub(npub: string): string {
  const { type, data } = nip19.decode(npub);
  if (type !== 'npub') {
    throw new Error(`expected npub, got ${type}`);
  }
  return data;
}

/** Decode a bech32 `nsec1...` string back to a raw secret key. */
export function decodeNsec(nsec: string): Uint8Array {
  const { type, data } = nip19.decode(nsec);
  if (type !== 'nsec') {
    throw new Error(`expected nsec, got ${type}`);
  }
  return data;
}
