import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeypair } from './keys.js';
import { buildNip98Event, nip98AuthHeader, NIP98_KIND } from './nip98.js';
import { verifyEvent, type NostrEvent } from './events.js';

function decodeHeader(header: string): { event: NostrEvent; json: string } {
  const encoded = header.slice('Nostr '.length);
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  const json = new TextDecoder().decode(bytes);
  return { event: JSON.parse(json) as NostrEvent, json };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('NIP-98 HTTP auth', () => {
  it('binds a valid signature to the exact URL and normalized method', () => {
    const identity = generateKeypair();
    const event = buildNip98Event(
      identity.secretKey,
      identity.publicKey,
      'https://relay.example/query',
      'post',
    );

    expect(event.kind).toBe(NIP98_KIND);
    expect(event.pubkey).toBe(identity.publicKey);
    expect(event.tags).toContainEqual(['u', 'https://relay.example/query']);
    expect(event.tags).toContainEqual(['method', 'POST']);
    expect(event.tags.find(([name]) => name === 'nonce')?.[1]).toMatch(/^[0-9a-f]{32}$/);
    expect(event.content).toBe('');
    expect(verifyEvent(event)).toBe(true);
  });

  it('base64-round-trips the exact signed JSON without Node Buffer', () => {
    vi.stubGlobal('Buffer', undefined);
    const identity = generateKeypair();
    const header = nip98AuthHeader(
      identity.secretKey,
      identity.publicKey,
      'https://relay.example/events',
      'POST',
    );
    const { event, json } = decodeHeader(header);

    expect(header).toMatch(/^Nostr [A-Za-z0-9+/]+={0,2}$/);
    expect(json).toBe(JSON.stringify(event));
    expect(event.tags).toContainEqual(['u', 'https://relay.example/events']);
    expect(event.tags).toContainEqual(['method', 'POST']);
    expect(verifyEvent(event)).toBe(true);
  });

  it('produces unique event IDs for repeated requests in the same second', () => {
    const identity = generateKeypair();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const first = buildNip98Event(
      identity.secretKey,
      identity.publicKey,
      'https://relay.example/query',
      'POST',
    );
    const second = buildNip98Event(
      identity.secretKey,
      identity.publicKey,
      'https://relay.example/query',
      'POST',
    );

    expect(first.created_at).toBe(second.created_at);
    expect(first.id).not.toBe(second.id);
  });
});
