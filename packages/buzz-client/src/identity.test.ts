import { describe, it, expect } from 'vitest';
import {
  createIdentity,
  identityNpub,
  identityNsec,
  loadIdentityFromNsec,
} from './identity.js';

describe('identity', () => {
  it('create → nsec → load round-trips the same pubkey', () => {
    const a = createIdentity('alice');
    expect(a.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(a.secretKey).toBeInstanceOf(Uint8Array);
    expect(a.secretKey.length).toBe(32);

    const nsec = identityNsec(a);
    expect(nsec.startsWith('nsec1')).toBe(true);
    const npub = identityNpub(a);
    expect(npub.startsWith('npub1')).toBe(true);

    const b = loadIdentityFromNsec(nsec, 'alice-reloaded');
    expect(b.publicKey).toBe(a.publicKey);
    expect(b.name).toBe('alice-reloaded');
  });
});
