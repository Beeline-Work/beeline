/**
 * Unit-test the CDP request construction: endpoint paths, the X-Wallet-Auth
 * ES256 signature over the sorted-body hash, and the developer JWT.
 *
 * These tests pin exactly what wire format we send to Coinbase, so a broken
 * endpoint path (like the old `/platform/v2/embedded-wallet-api/...` that
 * returned 404) or a malformed auth header is caught before the code reaches
 * production.
 *
 * Server-wallet model (rewritten 2026-11): no "end-user" entity. A wallet IS
 * an EVM account identified by its address. All paths are under
 * `/platform/v2/evm/...` and `/platform/v2/solana/...`.
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
      const jwt = cdpJwt(testEd25519Creds(), 'GET', '/platform/v2/evm/token-balances/base/0xabc');
      const parts = jwt.split('.');
      expect(parts).toHaveLength(3);
      const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString());
      expect(header.alg).toBe('EdDSA');
      expect(header.kid).toBe('test-kid');
      expect(header.typ).toBe('JWT');
      const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
      expect(payload.sub).toBe('test-kid');
      expect(payload.iss).toBe('cdp');
      expect(payload.uris).toEqual(['GET api.cdp.coinbase.com/platform/v2/evm/token-balances/base/0xabc']);
      expect(payload.exp - payload.nbf).toBe(120);
    });

    it('uses the correct CDP host in the uri claim', () => {
      const jwt = cdpJwt(testEd25519Creds(), 'POST', '/platform/v2/evm/accounts');
      const payload = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString());
      expect(payload.uris[0]).toContain('api.cdp.coinbase.com');
    });
  });

  describe('endpoint paths (server-wallet API)', () => {
    it('creates EVM accounts under /platform/v2/evm/accounts (NOT /platform/v2/embedded-wallet-api)', async () => {
      const creds = { ...testEd25519Creds(), walletSecret: testP256Key().privateKey };
      const client = new CdpWalletClient(creds);
      let capturedUrl = '';
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = async (url: RequestInfo | URL) => {
          capturedUrl = typeof url === 'string' ? url : url.toString();
          return new Response(JSON.stringify({ address: '0xabc', name: 'test-wallet', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }));
        };
        await client.createEvmAccount('test-wallet');
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(capturedUrl).toContain('/platform/v2/evm/accounts');
      expect(capturedUrl).not.toContain('/embedded-wallet-api');
      expect(capturedUrl).not.toContain('/platform/v2/users');
    });

    it('creates Solana accounts under /platform/v2/solana/accounts', async () => {
      const creds = { ...testEd25519Creds(), walletSecret: testP256Key().privateKey };
      const client = new CdpWalletClient(creds);
      let capturedUrl = '';
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = async (url: RequestInfo | URL) => {
          capturedUrl = typeof url === 'string' ? url : url.toString();
          return new Response(JSON.stringify({ address: 'SolTest', name: 'test-sol', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }));
        };
        await client.createSolanaAccount('test-sol');
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(capturedUrl).toContain('/platform/v2/solana/accounts');
      expect(capturedUrl).not.toContain('/embedded-wallet-api');
    });

    it('reads balances from /platform/v2/evm/token-balances/{network}/{address}', async () => {
      const creds = testEd25519Creds();
      const client = new CdpWalletClient(creds);
      let capturedUrl = '';
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = async (url: RequestInfo | URL) => {
          capturedUrl = typeof url === 'string' ? url : url.toString();
          return new Response(JSON.stringify({ balances: [] }));
        };
        await client.balances('base', '0xabc');
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(capturedUrl).toContain('/platform/v2/evm/token-balances/base/0xabc');
      expect(capturedUrl).not.toContain('/embedded-wallet-api');
      expect(capturedUrl).not.toContain('projectId=');
    });

    it('sends transactions under /platform/v2/evm/accounts/{address}/transfers', async () => {
      const creds = { ...testEd25519Creds(), walletSecret: testP256Key().privateKey };
      const client = new CdpWalletClient(creds);
      let capturedUrl = '';
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = async (url: RequestInfo | URL) => {
          capturedUrl = typeof url === 'string' ? url : url.toString();
          return new Response(JSON.stringify({ transaction_id: 'tx-1' }));
        };
        await client.sendTransaction('0xabc', {
          chain: 'base',
          asset: 'usdc',
          amount: '10.00',
          to: '0xdef',
        });
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(capturedUrl).toContain('/platform/v2/evm/accounts/0xabc/transfers');
      expect(capturedUrl).not.toContain('/embedded-wallet-api');
    });

    it('reads history from /platform/v2/evm/accounts/{address}/transfers', async () => {
      const creds = testEd25519Creds();
      const client = new CdpWalletClient(creds);
      let capturedUrl = '';
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = async (url: RequestInfo | URL) => {
          capturedUrl = typeof url === 'string' ? url : url.toString();
          return new Response(JSON.stringify({ transfers: [] }));
        };
        await client.history('0xabc', 10);
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(capturedUrl).toContain('/platform/v2/evm/accounts/0xabc/transfers');
      expect(capturedUrl).not.toContain('/embedded-wallet-api');
    });

    it('grep guarantees: no embedded-wallet-api path or createUser remains in the client', () => {
      // This test exists to GPT-proof the rewrite: if a future edit accidentally
      // reintroduces an end-user path, this fails.
      const source = require('fs').readFileSync(require('url').fileURLToPath(new URL('./cdp-client.ts', import.meta.url)), 'utf-8');
      expect(source).not.toMatch(/embedded-wallet-api/);
      expect(source).not.toMatch(/createUser/);
    });
  });

  describe('X-Wallet-Auth (ES256)', () => {
    it('includes x-wallet-auth header on wallet-authenticated requests (account creation)', async () => {
      const key = testP256Key();
      const creds = { ...testEd25519Creds(), walletSecret: key.privateKey };
      const client = new CdpWalletClient(creds);

      let capturedHeaders: Record<string, string> = {};
      let capturedBody = '';
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = async (url: RequestInfo | URL, opts?: RequestInit) => {
          capturedHeaders = (opts?.headers as Record<string, string>) ?? {};
          capturedBody = (opts?.body as string) ?? '';
          return new Response(JSON.stringify({ address: '0xabc', name: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
        };
        await client.createEvmAccount('test-wallet-1');
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
      // Body should be { name: "test-wallet-1" } sorted (only one key)
      const parsed = JSON.parse(capturedBody);
      expect(parsed.name).toBe('test-wallet-1');
    });

    it('computes reqHash from sorted body keys', async () => {
      const key = testP256Key();
      const creds = { ...testEd25519Creds(), walletSecret: key.privateKey };
      const client = new CdpWalletClient(creds);

      let capturedHeaders: Record<string, string> = {};
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = async (url: RequestInfo | URL, opts?: RequestInit) => {
          capturedHeaders = (opts?.headers as Record<string, string>) ?? {};
          return new Response(JSON.stringify({ address: '0xabc', name: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
        };
        await client.createEvmAccount('test-wallet-1');
      } finally {
        globalThis.fetch = originalFetch;
      }

      const walletPart = JSON.parse(
        Buffer.from(capturedHeaders['x-wallet-auth'].split('.')[1]!, 'base64url').toString(),
      );
      expect(walletPart.reqHash).toBeDefined();
      expect(walletPart.reqHash).toHaveLength(64);
    });

    it('does not send x-wallet-auth on dev-authenticated requests (balances, no wallet secret needed)', async () => {
      const creds = testEd25519Creds(); // no wallet secret
      const client = new CdpWalletClient(creds);

      let capturedHeaders: Record<string, string> = {};
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = async (url: RequestInfo | URL, opts?: RequestInit) => {
          capturedHeaders = (opts?.headers as Record<string, string>) ?? {};
          return new Response(JSON.stringify({ balances: [] }));
        };
        await client.balances('base', '0xabc');
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(capturedHeaders['authorization']).toBeDefined();
      expect(capturedHeaders['x-wallet-auth']).toBeUndefined();
    });
  });
});