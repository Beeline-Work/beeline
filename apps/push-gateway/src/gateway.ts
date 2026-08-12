import type { NostrEvent } from '@beeline/nostr';
import type { BatchResponse, Messaging } from 'firebase-admin/messaging';
import { isNotifiableEvent, mapEventToNotification } from './mapping.js';
import { NotificationMetadataResolver, type RelayEventReader } from './metadata.js';
import { TokenRegistry } from './registry.js';

const PERMANENT_TOKEN_ERRORS = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
]);

export type { RelayEventReader } from './metadata.js';

type PollResult = 'backoff' | 'busy' | 'empty' | 'polled';

function retryAfterMs(error: unknown): number | null {
  const match = String(error).match(/retry in\s+(\d+)s/i);
  return match ? (Number(match[1]) + 1) * 1_000 : null;
}

/**
 * Poll exactly one registered identity at a time.
 *
 * The relay applies one quota to this daemon. A full registry scan every tick
 * exhausts that quota and repeatedly aborts on the first identity. Round-robin
 * polling bounds the request rate, advances past failures, and preserves a
 * separate cursor for each ACL-scoped reader.
 */
export class RegisteredEventPoller {
  private cursor = 0;
  private polling = false;
  private backoffUntilMs = 0;
  private readonly sinceByPubkey = new Map<string, number>();
  private readonly seenEvents = new Map<string, number>();
  private readonly initialSince: number;

  constructor(
    private readonly registry: TokenRegistry,
    private readonly readerForPubkey: (pubkey: string) => RelayEventReader,
    private readonly handleEvent: (
      event: NostrEvent,
      recipientPubkey: string,
      reader: RelayEventReader,
    ) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {
    this.initialSince = Math.floor(this.now() / 1_000) - 5;
  }

  async pollNext(): Promise<PollResult> {
    if (this.polling) return 'busy';
    if (this.now() < this.backoffUntilMs) return 'backoff';

    const pubkeys = this.registry.pubkeys();
    if (pubkeys.length === 0) return 'empty';

    const recipientPubkey = pubkeys[this.cursor % pubkeys.length]!;
    this.cursor = (this.cursor + 1) % pubkeys.length;
    const since = this.sinceByPubkey.get(recipientPubkey) ?? this.initialSince;
    let newestCreatedAt = since;
    const reader = this.readerForPubkey(recipientPubkey);
    this.polling = true;

    try {
      const events = await reader.query([{ kinds: [9], since }]);
      events.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
      for (const event of events) {
        newestCreatedAt = Math.max(newestCreatedAt, event.created_at);
        const deliveryId = `${recipientPubkey}:${event.id}`;
        if (this.seenEvents.has(deliveryId)) continue;
        this.seenEvents.set(deliveryId, event.created_at);
        try {
          await this.handleEvent(event, recipientPubkey, reader);
        } catch (error) {
          this.seenEvents.delete(deliveryId);
          throw error;
        }
      }
      this.sinceByPubkey.set(recipientPubkey, Math.max(since, newestCreatedAt - 1));
      const expiry = Math.floor(this.now() / 1_000) - 600;
      for (const [deliveryId, createdAt] of this.seenEvents) {
        if (createdAt < expiry) this.seenEvents.delete(deliveryId);
      }
      return 'polled';
    } catch (error) {
      const delayMs = retryAfterMs(error);
      if (delayMs !== null) this.backoffUntilMs = this.now() + delayMs;
      throw error;
    } finally {
      reader.disconnect();
      this.polling = false;
    }
  }
}

export class PushGateway {
  constructor(
    private readonly registry: TokenRegistry,
    private readonly messaging: Messaging,
    private readonly metadata = new NotificationMetadataResolver(),
  ) {}

  async handleRelayEvent(
    event: NostrEvent,
    recipientPubkey: string,
    reader: RelayEventReader,
  ): Promise<void> {
    const channelId = event.tags.find((tag) => tag[0] === 'h')?.[1];
    if (!channelId) return;
    if (!isNotifiableEvent(event)) return;
    if (recipientPubkey === event.pubkey) return;

    // The relay query was performed as this registered identity, so visibility
    // is the membership/ACL decision. Deliver only to that reader's devices.
    const tokens = this.registry.tokensForPubkeys([recipientPubkey]);
    if (tokens.length === 0) return;

    const context = await this.metadata.resolve(event, reader);
    const plan = mapEventToNotification(event, context);
    if (!plan) return;

    const result = await this.messaging.sendEachForMulticast({
      tokens,
      notification: { title: plan.title, body: plan.body },
      data: plan.data,
      android: {
        collapseKey: channelId,
        priority: 'high',
        notification: { channelId: 'messages', tag: `room:${channelId}` },
      },
    });

    await this.removePermanentFailures(tokens, result);
    console.log(
      `[push] FCM sent event=${event.id.slice(0, 12)} channel=${channelId} recipient=${recipientPubkey.slice(0, 12)} devices=${tokens.length} success=${result.successCount} failure=${result.failureCount}`,
    );
  }

  private async removePermanentFailures(tokens: string[], result: BatchResponse): Promise<void> {
    const invalidTokens: string[] = [];
    result.responses.forEach((response, index) => {
      if (!response.success && response.error && PERMANENT_TOKEN_ERRORS.has(response.error.code)) {
        const token = tokens[index];
        if (token) invalidTokens.push(token);
      }
    });
    if (invalidTokens.length > 0) await this.registry.removeTokens(invalidTokens);
  }
}
