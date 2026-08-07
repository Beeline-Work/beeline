import { describe, expect, it } from 'vitest';
import {
  generateKeypair,
  getPublicKey,
  encodeNpub,
  encodeNsec,
  decodeNpub,
  decodeNsec,
} from './keys.js';
import { getEventHash, signEvent, verifyEvent, type UnsignedEvent } from './events.js';

function unsignedEvent(pubkey: string): UnsignedEvent {
  return {
    pubkey,
    created_at: 1700000000,
    kind: 1,
    tags: [],
    content: 'hello buzzy',
  };
}

describe('keygen + npub/nsec encoding', () => {
  it('generates a valid secp256k1 keypair', () => {
    const { secretKey, publicKey } = generateKeypair();
    expect(secretKey).toHaveLength(32);
    expect(publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(getPublicKey(secretKey)).toBe(publicKey);
  });

  it('round-trips npub/nsec bech32 encoding', () => {
    const { secretKey, publicKey } = generateKeypair();

    const npub = encodeNpub(publicKey);
    expect(npub.startsWith('npub1')).toBe(true);
    expect(decodeNpub(npub)).toBe(publicKey);

    const nsec = encodeNsec(secretKey);
    expect(nsec.startsWith('nsec1')).toBe(true);
    expect(decodeNsec(nsec)).toEqual(secretKey);
  });
});

describe('event signing', () => {
  it('signs an event and verifies it', () => {
    const { secretKey, publicKey } = generateKeypair();
    const unsigned = unsignedEvent(publicKey);

    const signed = signEvent(unsigned, secretKey);

    expect(signed.id).toBe(getEventHash(unsigned));
    expect(signed.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyEvent(signed)).toBe(true);
  });

  it('rejects an event whose content was tampered with after signing', () => {
    const { secretKey, publicKey } = generateKeypair();
    const signed = signEvent(unsignedEvent(publicKey), secretKey);

    const tampered = { ...signed, content: 'not what was signed' };

    expect(verifyEvent(tampered)).toBe(false);
  });

  it('rejects a signature produced by the wrong key', () => {
    const claimedSigner = generateKeypair();
    const actualSigner = generateKeypair();

    // Signed by actualSigner but claims to be from claimedSigner.
    const forged = signEvent(unsignedEvent(claimedSigner.publicKey), actualSigner.secretKey);

    expect(verifyEvent(forged)).toBe(false);
  });
});
