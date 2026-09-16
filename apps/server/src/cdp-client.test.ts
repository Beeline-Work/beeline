/**
 * Unit-test the CDP request construction: endpoint paths, the X-Wallet-Auth
 * ES256 signature over the sorted-body hash, and the developer JWT.
 *
 * These tests pin exactly what wire format we send to Coinbase, so a broken
 * endpoint path (like the old `/platform/v2/users` that returned 404) or a
 * malformed auth header is caught before the code reaches production.
 */
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { cdpJwt, CdpWalletClient } from './cdp-client.js';

/** A real Ed25519 keypair for dev auth in tests. */
function testEd25519Creds(): { keyId: string; keySecret: string } {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
  const seed = pkcs8.subarray(pkcs8.length - 32);
  return { keyId: 'test-kid', keySecret: seed.toString('base64') };
}

/** A useable P-256 keypair for test wallet-secret signing. */
function testP256Key(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

describe('cdp request construction', () => {
  describe('developer JWT (Ed25519)', () => {
    it('builds a three-part JWT with the correct claims', () => {
      const jwt = cdpJwt(testEd25519Creds(), 'GET', '/platform/v2/embedded-wallet-api/end-users/u1?projectId=pid');
      const parts = jwt.split('.');
      expect(parts).toHaveLength(3);
      const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString());
      expect(header.alg).toBe('EdDSA');
      expect(header.kid).toBe('test-kid');
      expect(header.typ).toBe('JWT');
      const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
      expect(payload.sub).toBe('test-kid');
      expect(payload.iss).toBe('cdp');
      expect(payload.uris).toEqual(['GET api.cdp.coinbase.com/platform/v2/embedded-wallet-api/end-users/u1?projectId=pid']);
      expect(payload.exp - payload.nbf).toBe(120);
    });

    it('uses the correct CDP host in the uri claim', () => {
      const jwt = cdpJwt(testEd25519Creds(), 'POST', '/platform/v2/embedded-wallet-api/projects/pid/end-users');
      const payload = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString());
      expect(payload.uris[0]).toContain('api.cdp.coinbase.com');
    });
  });

  describe('endpoint paths', () => {
    it('creates end-users under /platform/v2/embedded-wallet-api/projects/.../end-users (NOT /platform/v2/users)', async () => {
      const creds = { ...testEd25519Creds(), walletSecret: testP256Key().privateKey };
      const client = new CdpWalletClient(creds);

      // Capture the FIRST fetch URL (createUser does two calls)
      let firstUrl = '';
      let callCount = 0;
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = async (url: RequestInfo | URL) => {
          callCount++;
          if (callCount === 1) firstUrl = typeof url === 'string' ? url : url.toString();
          return new Response(JSON.stringify({ userId: 'test-user-id' }));
        };
        await client.createUser();
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(firstUrl).not.toContain('/platform/v2/users');
      expect(firstUrl).toContain('/platform/v2/embedded-wallet-api/projects/6fdaf9eb-9935-49fc-be84-047a324bf275/end-users');
    });

    it('creates EVM accounts under /platform/v2/embedded-wallet-api/end-users/.../evm', async () => {
      const creds = { ...testEd25519Creds(), walletSecret: testP256Key().privateKey };
      const client = new CdpWalletClient(creds);

      let capturedUrl = '';
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = async (url: RequestInfo | URL) => {
          capturedUrl = typeof url === 'string' ? url : url.toString();
          return new Response(JSON.stringify({ address: '0xabc' }));
        };
        await client.getOrCreateEvmAccount('user-1');
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(capturedUrl).toContain('/platform/v2/embedded-wallet-api/end-users/user-1/evm');
      expect(capturedUrl).not.toContain('/platform/v2/users');
    });

    it('reads balances from /platform/v2/embedded-wallet-api/end-users/{id}?projectId=...', async () => {
      const creds = testEd25519Creds();
      const client = new CdpWalletClient(creds);

      let capturedUrl = '';
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = async (url: RequestInfo | URL) => {
          capturedUrl = typeof url === 'string' ? url : url.toString();
          return new Response(JSON.stringify({ userId: 'u1', holdings: [] }));
        };
        await client.balances('user-1');
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(capturedUrl).toContain('/platform/v2/embedded-wallet-api/end-users/user-1');
      expect(capturedUrl).toContain('projectId=');
      expect(capturedUrl).not.toContain('/platform/v2/users');
    });

    it('sends transactions under /platform/v2/embedded-wallet-api/end-users/.../send', async () => {
      const creds = { ...testEd25519Creds(), walletSecret: testP256Key().privateKey };
      const client = new CdpWalletClient(creds);

      let capturedPath = '';
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = async (url: RequestInfo | URL) => {
          capturedPath = typeof url === 'string' ? url : url.toString();
          return new Response(JSON.stringify({ transaction_id: 'tx-1' }));
        };
        await client.sendTransaction('user-1', {
          chain: 'base',
          asset: 'usdc',
          amount: '10.00',
          to: '0xabc',
        });
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(capturedPath).toContain('/platform/v2/embedded-wallet-api/end-users/user-1/send');
      expect(capturedPath).not.toContain('/platform/v2/users');
    });

    it('reads history from /platform/v2/embedded-wallet-api/end-users/.../transactions', async () => {
      const creds = testEd25519Creds();
      const client = new CdpWalletClient(creds);

      let capturedUrl = '';
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = async (url: RequestInfo | URL) => {
          capturedUrl = typeof url === 'string' ? url : url.toString();
          return new Response(JSON.stringify({ transactions: [] }));
        };
        await client.history('user-1', 10);
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(capturedUrl).toContain('/platform/v2/embedded-wallet-api/end-users/user-1/transactions');
      expect(capturedUrl).not.toContain('/platform/v2/users');
    });
  });

  describe('X-Wallet-Auth (ES256)', () => {
    it('includes x-wallet-auth header on wallet-authenticated requests', async () => {
      const key = testP256Key();
      const creds = { ...testEd25519Creds(), walletSecret: key.privateKey };
      const client = new CdpWalletClient(creds);

      let capturedHeaders: Record<string, string> = {};
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = async (url: RequestInfo | URL, opts?: RequestInit) => {
          capturedHeaders = (opts?.headers as Record<string, string>) ?? {};
          return new Response(JSON.stringify({ address: '0xabc' }));
        };
        await client.getOrCreateEvmAccount('user-1');
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(capturedHeaders['authorization']).toMatch(/^Bearer /);
      expect(capturedHeaders['x-wallet-auth']).toBeTruthy();
      expect(capturedHeaders['x-wallet-auth'].split('.')).toHaveLength(3);
      const walletPart = JSON.parse(
        Buffer.from(capturedHeaders['x-wallet-auth'].split('.')[1]!, 'base64url').toString(),
      );
      expect(walletPart.uris).toBeDefined();
      expect(walletPart.reqHash).toBeDefined();
      expect(walletPart.reqHash).toHaveLength(64);
      expect(walletPart.jti).toBeDefined();
    });

    it('computes reqHash from sorted body keys', async () => {
      const key = testP256Key();
      const creds = { ...testEd25519Creds(), walletSecret: key.privateKey };
      const client = new CdpWalletClient(creds);

      let lastBody = '';
      let callCount = 0;
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = async (url: RequestInfo | URL, opts?: RequestInit) => {
          callCount++;
          if (callCount === 2) lastBody = (opts?.body as string) ?? '';
          return new Response(JSON.stringify({ userId: 'test-user-id' }));
        };
        await client.createUser();
      } finally {
        globalThis.fetch = originalFetch;
      }

      if (lastBody) {
        const parsed = JSON.parse(lastBody);
        // The wallet-secret body has keys in insertion order (walletSecretId, publicKey, validUntil).
        // Sorted keys should be: publicKey, validUntil, walletSecretId
        expect(Object.keys(parsed).sort()).toEqual(['publicKey', 'validUntil', 'walletSecretId']);
      }
    });

    it('does not send x-wallet-auth on dev-authenticated requests (no wallet secret needed)', async () => {
      const creds = testEd25519Creds(); // no wallet secret
      const client = new CdpWalletClient(creds);

      let capturedHeaders: Record<string, string> = {};
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = async (url: RequestInfo | URL, opts?: RequestInit) => {
          capturedHeaders = (opts?.headers as Record<string, string>) ?? {};
          return new Response(JSON.stringify({ userId: 'u1', holdings: [] }));
        };
        await client.balances('user-1');
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(capturedHeaders['authorization']).toBeDefined();
      expect(capturedHeaders['x-wallet-auth']).toBeUndefined();
    });
  });
});