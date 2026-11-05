
import { describe as move16_describe, expect as move16_expect, it as move16_it } from 'vitest';

import {
  generateKeypair as move16_generateKeypair,
  getPublicKey as move16_getPublicKey,
  encodeNpub as move16_encodeNpub,
  encodeNsec as move16_encodeNsec,
  decodeNpub as move16_decodeNpub,
  decodeNsec as move16_decodeNsec,
} from "./keys.js";

import { getEventHash as move16_getEventHash, signEvent as move16_signEvent, verifyEvent as move16_verifyEvent, type UnsignedEvent as move16_UnsignedEvent } from "./events.js";
import { describe as movedDescribe16 } from 'vitest';
movedDescribe16("nostr.test.ts", () => {


function unsignedEvent(pubkey: string): move16_UnsignedEvent {
  return {
    pubkey,
    created_at: 1700000000,
    kind: 1,
    tags: [],
    content: 'hello buzzy',
  };
}


move16_describe('keygen + npub/nsec encoding', () => {
  move16_it('generates a valid secp256k1 keypair', () => {
    const { secretKey, publicKey } = move16_generateKeypair();
    move16_expect(secretKey).toHaveLength(32);
    move16_expect(publicKey).toMatch(/^[0-9a-f]{64}$/);
    move16_expect(move16_getPublicKey(secretKey)).toBe(publicKey);
  });

  move16_it('round-trips npub/nsec bech32 encoding', () => {
    const { secretKey, publicKey } = move16_generateKeypair();

    const npub = move16_encodeNpub(publicKey);
    move16_expect(npub.startsWith('npub1')).toBe(true);
    move16_expect(move16_decodeNpub(npub)).toBe(publicKey);

    const nsec = move16_encodeNsec(secretKey);
    move16_expect(nsec.startsWith('nsec1')).toBe(true);
    move16_expect(move16_decodeNsec(nsec)).toEqual(secretKey);
  });
});


move16_describe('event signing', () => {
  move16_it('signs an event and verifies it', () => {
    const { secretKey, publicKey } = move16_generateKeypair();
    const unsigned = unsignedEvent(publicKey);

    const signed = move16_signEvent(unsigned, secretKey);

    move16_expect(signed.id).toBe(move16_getEventHash(unsigned));
    move16_expect(signed.sig).toMatch(/^[0-9a-f]{128}$/);
    move16_expect(move16_verifyEvent(signed)).toBe(true);
  });

  move16_it('rejects an event whose content was tampered with after signing', () => {
    const { secretKey, publicKey } = move16_generateKeypair();
    const signed = move16_signEvent(unsignedEvent(publicKey), secretKey);

    const tampered = { ...signed, content: 'not what was signed' };

    move16_expect(move16_verifyEvent(tampered)).toBe(false);
  });

  move16_it('rejects a signature produced by the wrong key', () => {
    const claimedSigner = move16_generateKeypair();
    const actualSigner = move16_generateKeypair();

    // Signed by actualSigner but claims to be from claimedSigner.
    const forged = move16_signEvent(unsignedEvent(claimedSigner.publicKey), actualSigner.secretKey);

    move16_expect(move16_verifyEvent(forged)).toBe(false);
  });
});
});
