/** Authenticated HTTP client for the Buzz relay bridge. */
import type { NostrEvent } from '@beeline/nostr';
import {
  publishEvent as publishHttpEvent,
  requestQueryEvents,
} from '@beeline/buzz-client';
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
      const events = await requestQueryEvents(
        { baseUrl, host: config.host, identity },
        filters,
        identity.publicKey,
      );
      return [...events];
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
