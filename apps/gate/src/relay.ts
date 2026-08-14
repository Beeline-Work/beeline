/** Authenticated HTTP client for the Buzz relay bridge. */
import { nip98AuthHeader, type NostrEvent } from '@beeline/nostr';
import { publishEvent as publishHttpEvent } from '@beeline/buzz-client';
import { BASE_URL, HOST } from './config.js';
import type { Identity } from './identity.js';

export interface SubmitResult {
  status: number;
  accepted: boolean;
  body: unknown;
}

export interface RelayHttpConfig {
  baseUrl: string;
  host: string;
}

export interface RelayReader {
  queryEvents(filters: Record<string, unknown>[]): Promise<NostrEvent[]>;
}

export interface RelayClient extends RelayReader {
  publishEvent(event: NostrEvent): Promise<SubmitResult>;
}

const QUERY_MAX_ATTEMPTS = 3;
const QUERY_ATTEMPT_TIMEOUT_MS = 10_000;
const QUERY_RETRY_BASE_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function headers(
  identity: Pick<Identity, 'secretKey' | 'publicKey'>,
  url: string,
  method: string,
): Record<string, string> {
  return {
    'content-type': 'application/json',
    host: new URL(url).host,
    'x-pubkey': identity.publicKey,
    authorization: nip98AuthHeader(identity.secretKey, identity.publicKey, url, method),
  };
}

/**
 * Bind one signing identity to every relay read and write. Daemon code uses
 * this client instead of assembling auth independently at each call site.
 */
export function createRelayClient(
  identity: Pick<Identity, 'secretKey' | 'publicKey'>,
  config: RelayHttpConfig = { baseUrl: BASE_URL, host: HOST },
): RelayClient {
  const baseUrl = config.baseUrl.replace(/\/$/, '');

  return {
    async publishEvent(event: NostrEvent): Promise<SubmitResult> {
      if (event.pubkey !== identity.publicKey) {
        throw new Error('relay auth identity must match the published event signer');
      }
      return publishHttpEvent({ baseUrl, host: config.host, identity }, event);
    },

    async queryEvents(filters: Record<string, unknown>[]): Promise<NostrEvent[]> {
      const url = `${baseUrl}/query`;
      const method = 'POST';
      for (let attempt = 1; attempt <= QUERY_MAX_ATTEMPTS; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), QUERY_ATTEMPT_TIMEOUT_MS);
        try {
          const res = await fetch(url, {
            method,
            headers: { ...headers(identity, url, method), host: config.host },
            body: JSON.stringify(filters),
            signal: controller.signal,
          });
          const text = await res.text();
          if (res.ok) {
            const parsed = JSON.parse(text) as unknown;
            if (!Array.isArray(parsed)) {
              throw new Error(`queryEvents: expected array, got ${text.slice(0, 200)}`);
            }
            return parsed as NostrEvent[];
          }
          if (res.status >= 500 && res.status <= 599 && attempt < QUERY_MAX_ATTEMPTS) {
            await sleep(QUERY_RETRY_BASE_MS * attempt);
            continue;
          }
          throw Object.assign(new Error(`queryEvents failed: HTTP ${res.status} ${text}`), {
            nonRetryable: true,
          });
        } catch (error) {
          if (
            typeof error === 'object' &&
            error !== null &&
            'nonRetryable' in error &&
            error.nonRetryable === true
          ) {
            throw error;
          }
          if (attempt === QUERY_MAX_ATTEMPTS) {
            throw new Error(
              `queryEvents failed after ${attempt} attempts: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          await sleep(QUERY_RETRY_BASE_MS * attempt);
          continue;
        } finally {
          clearTimeout(timeout);
        }
      }
      throw new Error(`queryEvents exhausted ${QUERY_MAX_ATTEMPTS} attempts`);
    },
  };
}

/** Publish with mandatory NIP-98 auth. */
export function publishEvent(event: NostrEvent, identity: Identity): Promise<SubmitResult> {
  return createRelayClient(identity).publishEvent(event);
}

/** Query with mandatory NIP-98 auth. Anonymous reads must use an explicitly named API. */
export function queryEvents(
  filters: Record<string, unknown>[],
  identity: Identity,
): Promise<NostrEvent[]> {
  return createRelayClient(identity).queryEvents(filters);
}
