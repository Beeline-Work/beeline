import { createHash, randomBytes } from 'node:crypto';
import { NIP98_KIND, verifyEvent, type NostrEvent } from '@beeline/nostr';

export const OIDC_BIND_KIND = 24_250;
export const OIDC_BIND_MARKER = 'beeline-oidc-bind-v1';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function normalizeIssuer(value: string, allowInsecure = false): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('OIDC issuer must not contain credentials, a query, or a fragment');
  }
  if (url.protocol !== 'https:' && !(allowInsecure && url.protocol === 'http:')) {
    throw new Error('OIDC issuer must use https');
  }
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === 'https:' && url.port === '443') ||
    (url.protocol === 'http:' && url.port === '80')
  ) {
    url.port = '';
  }
  return url.toString().replace(/\/$/, '');
}

export function normalizeHost(value: string): string {
  if (!value || value.includes(',') || /[\s/@]/.test(value)) throw new Error('invalid Host header');
  const url = new URL(`http://${value}`);
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('invalid Host header');
  }
  return url.port ? `${url.hostname.toLowerCase()}:${url.port}` : url.hostname.toLowerCase();
}

export interface BindExpectation {
  ticket: string;
  challenge: string;
  issuer: string;
  audience: string;
  subject: string;
  community: string;
  issuedAt: Date;
  expiresAt: Date;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

export function asNostrEvent(value: unknown): NostrEvent | null {
  if (!value || typeof value !== 'object') return null;
  const event = value as Partial<NostrEvent>;
  if (
    typeof event.id !== 'string' ||
    typeof event.sig !== 'string' ||
    typeof event.pubkey !== 'string' ||
    typeof event.created_at !== 'number' ||
    !Number.isSafeInteger(event.created_at) ||
    typeof event.kind !== 'number' ||
    !Number.isSafeInteger(event.kind) ||
    !Array.isArray(event.tags) ||
    !event.tags.every(isStringArray) ||
    typeof event.content !== 'string'
  ) {
    return null;
  }
  if (
    !/^[0-9a-f]{64}$/.test(event.id) ||
    !/^[0-9a-f]{64}$/.test(event.pubkey) ||
    !/^[0-9a-f]{128}$/.test(event.sig)
  ) {
    return null;
  }
  if (event.tags.length > 32 || event.content.length > 4_096) return null;
  return event as NostrEvent;
}

function exactTag(event: NostrEvent, name: string, expected: string): boolean {
  const matches = event.tags.filter((tag) => tag[0] === name);
  return matches.length === 1 && matches[0]!.length === 2 && matches[0]![1] === expected;
}

export function verifyBindEvent(
  value: unknown,
  expected: BindExpectation,
  now = new Date(),
  clockSkewSeconds = 60,
): { ok: true; event: NostrEvent } | { ok: false; reason: string } {
  const event = asNostrEvent(value);
  if (!event) return { ok: false, reason: 'malformed signed bind event' };
  if (event.kind !== OIDC_BIND_KIND) return { ok: false, reason: 'wrong bind event kind' };
  if (event.content !== '') return { ok: false, reason: 'bind event content must be empty' };

  const tags: ReadonlyArray<readonly [string, string]> = [
    ['t', OIDC_BIND_MARKER],
    ['ticket', expected.ticket],
    ['challenge', expected.challenge],
    ['provider', expected.issuer],
    ['audience', expected.audience],
    ['subject', expected.subject],
    ['community', expected.community],
  ];
  const allowedTags = new Set(tags.map(([name]) => name));
  if (event.tags.length !== tags.length || event.tags.some((tag) => !allowedTags.has(tag[0]!))) {
    return { ok: false, reason: 'bind event has unexpected or duplicate tags' };
  }
  for (const [name, expectedValue] of tags) {
    if (!exactTag(event, name, expectedValue)) {
      return { ok: false, reason: `bind event ${name} tag mismatch` };
    }
  }

  const createdAtMs = event.created_at * 1_000;
  const skewMs = clockSkewSeconds * 1_000;
  if (
    createdAtMs < expected.issuedAt.getTime() - skewMs ||
    createdAtMs > expected.expiresAt.getTime() ||
    createdAtMs > now.getTime() + skewMs
  ) {
    return { ok: false, reason: 'bind event timestamp outside ticket window' };
  }
  if (!verifyEvent(event)) return { ok: false, reason: 'invalid bind event signature' };
  return { ok: true, event };
}

export function verifyNip98Header(
  authorization: string | undefined,
  expectedUrl: string,
  method: string,
  now = new Date(),
  clockSkewSeconds = 60,
): { ok: true; pubkey: string; eventId: string } | { ok: false; reason: string } {
  if (!authorization?.startsWith('Nostr '))
    return { ok: false, reason: 'NIP-98 authentication required' };
  const encoded = authorization.slice('Nostr '.length);
  if (!encoded || encoded.length > 32_768 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    return { ok: false, reason: 'malformed NIP-98 authentication' };
  }

  let parsed: unknown;
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    if (decoded.length > 16_384) throw new Error('too large');
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    return { ok: false, reason: 'malformed NIP-98 authentication' };
  }
  const event = asNostrEvent(parsed);
  if (!event || event.kind !== NIP98_KIND || event.content !== '') {
    return { ok: false, reason: 'invalid NIP-98 event' };
  }
  if (
    event.tags.length !== 3 ||
    !exactTag(event, 'u', expectedUrl) ||
    !exactTag(event, 'method', method.toUpperCase())
  ) {
    return { ok: false, reason: 'NIP-98 request binding mismatch' };
  }
  const nonceTags = event.tags.filter((tag) => tag[0] === 'nonce');
  if (nonceTags.length !== 1 || nonceTags[0]!.length !== 2 || !nonceTags[0]![1]) {
    return { ok: false, reason: 'NIP-98 nonce required' };
  }
  const allowedTags = new Set(['u', 'method', 'nonce']);
  if (event.tags.some((tag) => !allowedTags.has(tag[0]!))) {
    return { ok: false, reason: 'unexpected NIP-98 tag' };
  }
  if (Math.abs(now.getTime() / 1_000 - event.created_at) > clockSkewSeconds) {
    return { ok: false, reason: 'stale NIP-98 authentication' };
  }
  if (!verifyEvent(event)) return { ok: false, reason: 'invalid NIP-98 signature' };
  return { ok: true, pubkey: event.pubkey, eventId: event.id };
}
