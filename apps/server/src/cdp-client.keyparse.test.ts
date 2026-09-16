import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { cdpJwt } from './cdp-client.js';

describe('cdp Ed25519 key parsing', () => {
  it('signs with a raw 64-byte Ed25519 secret (the shape CDP hands out)', () => {
    // A CDP API key secret is the base64 of the raw 64-byte Ed25519 key
    // (32-byte seed + 32-byte public). Node's PKCS8 export starts with a
    // 16-byte prefix, so slice it back to the seed and append the public half
    // to reproduce CDP's exact 64-byte shape.
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
    const seed = pkcs8.subarray(pkcs8.length - 32);
    const pub = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32);
    const rawSecret = Buffer.concat([seed, pub]).toString('base64');
    // Before the fix this threw DECODER routines::unsupported.
    const jwt = cdpJwt({ keyId: 'test-kid', keySecret: rawSecret }, 'GET', '/v2/x');
    expect(jwt.split('.')).toHaveLength(3);
  });
});
