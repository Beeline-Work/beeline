import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeNip05Identifier, parseNip05Identifier, verifyNip05 } from './nip05.js';

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
