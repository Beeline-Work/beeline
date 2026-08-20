import { nip98AuthHeader } from '@beeline/nostr';
import type { Identity } from './types.js';

const NIP05_LOCAL_RE = /^[a-z0-9_.-]+$/i;
const NIP05_DOMAIN_RE =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const NIP05_MAX_LENGTH = 255;
const HEX_PUBKEY_RE = /^[0-9a-f]{64}$/;

export interface ParsedNip05 {
  local: string;
  domain: string;
}

/** Parse and normalize a `name@domain` NIP-05 identifier. Does not touch the network. */
export function parseNip05Identifier(identifier: string): ParsedNip05 | null {
  const trimmed = identifier.trim();
  if (!trimmed || trimmed.length > NIP05_MAX_LENGTH) return null;
  const at = trimmed.indexOf('@');
  if (at <= 0 || at !== trimmed.lastIndexOf('@')) return null;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1).toLowerCase();
  if (!NIP05_LOCAL_RE.test(local) || !NIP05_DOMAIN_RE.test(domain)) return null;
  return { local, domain };
}

/** Normalized `name@domain` form, or null if the identifier is not well-formed. */
export function normalizeNip05Identifier(identifier: string): string | null {
  const parsed = parseNip05Identifier(identifier);
  return parsed ? `${parsed.local}@${parsed.domain}` : null;
}

export type Nip05VerificationStatus = 'verified' | 'mismatch' | 'unreachable' | 'invalid';

export interface Nip05VerificationResult {
  identifier: string;
  status: Nip05VerificationStatus;
}

const DEFAULT_NIP05_TIMEOUT_MS = 6_000;

/**
 * Resolve `https://<domain>/.well-known/nostr.json?name=<local>` (NIP-05) and check it maps
 * back to `expectedPubkey`. Never throws — every failure mode (bad format, unreachable domain,
 * malformed response, name/pubkey mismatch) resolves to a distinct honest status.
 */
export async function verifyNip05(
  identifier: string,
  expectedPubkey: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<Nip05VerificationResult> {
  const parsed = parseNip05Identifier(identifier);
  if (!parsed || !HEX_PUBKEY_RE.test(expectedPubkey)) {
    return { identifier, status: 'invalid' };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_NIP05_TIMEOUT_MS;
  const url = new URL(`https://${parsed.domain}/.well-known/nostr.json`);
  url.searchParams.set('name', parsed.local);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), { signal: controller.signal });
  } catch {
    return { identifier, status: 'unreachable' };
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) return { identifier, status: 'unreachable' };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { identifier, status: 'unreachable' };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { identifier, status: 'unreachable' };
  }
  const names = (body as Record<string, unknown>).names;
  if (!names || typeof names !== 'object' || Array.isArray(names)) {
    return { identifier, status: 'unreachable' };
  }
  const resolved = (names as Record<string, unknown>)[parsed.local];
  if (typeof resolved !== 'string' || !HEX_PUBKEY_RE.test(resolved.toLowerCase())) {
    return { identifier, status: 'mismatch' };
  }
  return {
    identifier,
    status: resolved.toLowerCase() === expectedPubkey.toLowerCase() ? 'verified' : 'mismatch',
  };
}

export class Nip05ClaimError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'Nip05ClaimError';
  }
}

export interface Nip05ClaimResult {
  claimed: true;
  idempotent: boolean;
  name: string;
  pubkey: string;
}

async function claimResponseBody(response: Response): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Nip05ClaimError(
      'invalid_response',
      'auth service returned an invalid response',
      response.status,
    );
  }
  return body as Record<string, unknown>;
}

/**
 * Claim `<name>@usebeeline.app` first-come-first-served against the deployed auth service.
 * Does not touch the person profile — the caller writes `nip05` on success.
 */
export async function claimNip05Handle(
  baseUrl: string,
  identity: Pick<Identity, 'secretKey' | 'publicKey'>,
  name: string,
): Promise<Nip05ClaimResult> {
  if (!HEX_PUBKEY_RE.test(identity.publicKey)) {
    throw new Nip05ClaimError('invalid_identity', 'invalid public key');
  }
  const url = new URL('/nip05/claim', baseUrl).toString();
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: nip98AuthHeader(identity.secretKey, identity.publicKey, url, 'POST'),
      },
      body: JSON.stringify({ name }),
    });
  } catch (error) {
    throw new Nip05ClaimError(
      'offline',
      error instanceof Error ? error.message : 'auth service unavailable',
    );
  }
  const body = await claimResponseBody(response);
  if (!response.ok) {
    const code = typeof body.error === 'string' ? body.error : 'auth_service_error';
    const message =
      typeof body.message === 'string'
        ? body.message
        : `auth service returned HTTP ${response.status}`;
    throw new Nip05ClaimError(code, message, response.status);
  }
  if (
    body.claimed !== true ||
    typeof body.idempotent !== 'boolean' ||
    typeof body.name !== 'string' ||
    typeof body.pubkey !== 'string' ||
    !HEX_PUBKEY_RE.test(body.pubkey) ||
    body.pubkey !== identity.publicKey
  ) {
    throw new Nip05ClaimError(
      'invalid_response',
      'auth service returned an invalid claim result',
      response.status,
    );
  }
  return body as unknown as Nip05ClaimResult;
}
