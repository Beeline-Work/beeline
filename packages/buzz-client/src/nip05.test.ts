import { generateKeypair } from '@beeline/nostr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  claimNip05Handle,
  Nip05ClaimError,
  normalizeManagedHandle,
  normalizeNip05Identifier,
  parseManagedIdentity,
  parseNip05Identifier,
  verifyNip05,
} from './nip05.js';

const pubkey = 'a'.repeat(64);
const otherPubkey = 'b'.repeat(64);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('parseNip05Identifier', () => {
  it('parses a well-formed identifier and lowercases the domain', () => {
    expect(parseNip05Identifier('Bob@Example.COM')).toEqual({ local: 'Bob', domain: 'example.com' });
  });

  it('rejects malformed identifiers', () => {
    expect(parseNip05Identifier('not-an-identifier')).toBeNull();
    expect(parseNip05Identifier('bob@')).toBeNull();
    expect(parseNip05Identifier('@example.com')).toBeNull();
    expect(parseNip05Identifier('bob@two@example.com')).toBeNull();
    expect(parseNip05Identifier('bob@not_a_domain')).toBeNull();
    expect(parseNip05Identifier('bo b@example.com')).toBeNull();
    expect(parseNip05Identifier('')).toBeNull();
    expect(parseNip05Identifier('a'.repeat(256) + '@example.com')).toBeNull();
  });
});

describe('normalizeNip05Identifier', () => {
  it('round-trips a valid identifier', () => {
    expect(normalizeNip05Identifier(' bob@Example.com ')).toBe('bob@example.com');
  });

  it('returns null for an invalid identifier', () => {
    expect(normalizeNip05Identifier('nope')).toBeNull();
  });
});

describe('normalizeManagedHandle', () => {
  it('normalizes the hosted ceremony format and rejects short, underscored, or reserved names', () => {
    expect(normalizeManagedHandle(' Ada-Labs ')).toBe('ada-labs');
    expect(normalizeManagedHandle('ab')).toBeNull();
    expect(normalizeManagedHandle('ada_labs')).toBeNull();
    expect(normalizeManagedHandle('admin')).toBeNull();
  });
});

describe('parseManagedIdentity', () => {
  it('accepts GitHub-length handles but binds the hosted identifier to that exact handle', () => {
    const handle = 'a'.repeat(39);
    expect(
      parseManagedIdentity({
        handle,
        display_name: 'GitHub Person',
        nip05: `${handle}@usebeeline.app`,
        source: 'github',
        github_login: handle,
        github_rename_available: false,
      }),
    ).toMatchObject({ handle, source: 'github' });
    expect(
      parseManagedIdentity({
        handle: 'alice',
        display_name: 'Alice',
        nip05: 'mallory@usebeeline.app',
        source: 'key',
        github_rename_available: false,
      }),
    ).toBeNull();
  });
});

describe('verifyNip05', () => {
  it('reports verified when the domain maps the name back to the expected pubkey', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        expect(String(input)).toBe('https://example.com/.well-known/nostr.json?name=bob');
        return jsonResponse({ names: { bob: pubkey } });
      }),
    );
    const result = await verifyNip05('bob@example.com', pubkey);
    expect(result).toEqual({ identifier: 'bob@example.com', status: 'verified' });
  });

  it('reports mismatch when the domain maps the name to a different pubkey', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ names: { bob: otherPubkey } })));
    const result = await verifyNip05('bob@example.com', pubkey);
    expect(result.status).toBe('mismatch');
  });

  it('reports mismatch when the name is absent from the response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ names: {} })));
    const result = await verifyNip05('bob@example.com', pubkey);
    expect(result.status).toBe('mismatch');
  });

  it('reports unreachable on network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    const result = await verifyNip05('bob@example.com', pubkey);
    expect(result.status).toBe('unreachable');
  });

  it('reports unreachable on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 404)));
    const result = await verifyNip05('bob@example.com', pubkey);
    expect(result.status).toBe('unreachable');
  });

  it('reports unreachable on a malformed JSON body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not json', { status: 200 })),
    );
    const result = await verifyNip05('bob@example.com', pubkey);
    expect(result.status).toBe('unreachable');
  });

  it('reports invalid for a malformed identifier without touching the network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await verifyNip05('not-an-identifier', pubkey);
    expect(result.status).toBe('invalid');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports invalid for a malformed expected pubkey', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await verifyNip05('bob@example.com', 'not-hex');
    expect(result.status).toBe('invalid');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('claimNip05Handle', () => {
  it('signs a NIP-98 POST with the requested name and returns the claim result', async () => {
    const identity = generateKeypair();
    const fetchSpy = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://auth.example/nip05/claim');
      expect(init?.method).toBe('POST');
      expect(String(init?.headers && (init.headers as Record<string, string>).authorization)).toMatch(
        /^Nostr /,
      );
      expect(JSON.parse(String(init?.body))).toEqual({ name: 'alice' });
      return jsonResponse({
        claimed: true,
        idempotent: false,
        name: 'alice',
        pubkey: identity.publicKey,
        identity: {
          handle: 'alice',
          display_name: 'Alice',
          nip05: 'alice@usebeeline.app',
          source: 'key',
          github_rename_available: false,
        },
      });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const result = await claimNip05Handle('https://auth.example', identity, 'alice');
    expect(result).toEqual({
      claimed: true,
      idempotent: false,
      name: 'alice',
      pubkey: identity.publicKey,
      identity: {
        handle: 'alice',
        displayName: 'Alice',
        nip05: 'alice@usebeeline.app',
        source: 'key',
        githubRenameAvailable: false,
      },
    });
  });

  it('throws a Nip05ClaimError carrying the service error code on a taken name', async () => {
    const identity = generateKeypair();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'name_taken', message: 'handle is already claimed' }, 409)),
    );
    await expect(claimNip05Handle('https://auth.example', identity, 'alice')).rejects.toMatchObject({
      code: 'name_taken',
      status: 409,
    });
  });

  it('throws an offline Nip05ClaimError on network failure', async () => {
    const identity = generateKeypair();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    await expect(claimNip05Handle('https://auth.example', identity, 'alice')).rejects.toBeInstanceOf(
      Nip05ClaimError,
    );
  });
});
