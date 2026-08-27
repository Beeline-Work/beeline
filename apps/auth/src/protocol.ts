import { createHash, randomBytes } from 'node:crypto';
import { verifyEvent, type NostrEvent } from '@beeline/nostr';

export { verifyNip98Header } from '@beeline/nostr';

export const OIDC_BIND_KIND = 24_250;
export const OIDC_BIND_MARKER = 'beeline-oidc-bind-v1';

const MANAGED_HANDLE_RE = /^[a-z0-9][a-z0-9-]{2,29}$/;
const NIP05_LOOKUP_NAME_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;
const NIP05_BLOCKED_NAMES = new Set(['admin', 'support', 'beeline']);

/** Key-only ceremony handles: lowercase alnum + `-`, 3-30 chars, not reserved. */
export function isValidNip05Name(name: string): boolean {
  return MANAGED_HANDLE_RE.test(name) && !NIP05_BLOCKED_NAMES.has(name);
}

/** Hosted names may also be GitHub-derived (GitHub permits 1-39 characters). */
export function isResolvableNip05Name(name: string): boolean {
  return NIP05_LOOKUP_NAME_RE.test(name);
}

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
  protocol: number;
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
    ['protocol', String(expected.protocol)],
    ['ticket', expected.ticket],
    ['challenge', expected.challenge],
    ['provider', expected.issuer],
    ['audience', expected.audience],
    ['subject', expected.subject],
    ['community', expected.community],
    ['issued_at', String(Math.floor(expected.issuedAt.getTime() / 1_000))],
    ['expires_at', String(Math.floor(expected.expiresAt.getTime() / 1_000))],
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
