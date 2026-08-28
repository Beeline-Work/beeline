import { createHash } from 'node:crypto';
import {
  KIND_AGENT_SOUL,
  KIND_CORNER_STATE,
  TAG_AGENT_SOUL,
  TAG_CORNER_STATE,
  parseCornerStateRecord,
} from '@beeline/buzz-client';
import type { NostrEvent } from '@beeline/nostr';
import type { BatchResponse, Messaging } from 'firebase-admin/messaging';
import { DeliveryState } from './delivery-state.js';
import {
  isSuppressedFixtureNotification,
  mapEventToNotification,
  mentionsMember,
  type PushNotificationPlan,
} from './mapping.js';
import { NotificationMetadataResolver, type RelayEventReader } from './metadata.js';
import { TokenRegistry } from './registry.js';

const PERMANENT_TOKEN_ERRORS = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
]);

export type { RelayEventReader } from './metadata.js';

export interface TestDeviceResult {
  deviceId: string;
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface TestSendReport {
  pubkey: string;
  successCount: number;
  failureCount: number;
  devices: TestDeviceResult[];
}

type PollResult = 'backoff' | 'busy' | 'empty' | 'polled';

function registeredEventFilters(since: number): Record<string, unknown>[] {
  return [
    { kinds: [9], since, limit: 1_000 },
    { kinds: [KIND_AGENT_SOUL], '#t': [TAG_AGENT_SOUL], since, limit: 1_000 },
    { kinds: [KIND_CORNER_STATE], '#t': [TAG_CORNER_STATE], since, limit: 1_000 },
  ];
}

function retryAfterMs(error: unknown): number | null {
  const match = String(error).match(/retry in\s+(\d+)s/i);
  return match ? (Number(match[1]) + 1) * 1_000 : null;
}

function logValue(value: string | number): string {
  return encodeURIComponent(String(value));
}

function deviceId(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/** One pending approval is identified by the immutable corner and exact merge target, not a retry event. */
function deliveryKey(event: NostrEvent, type: string): string {
  if (type !== 'merge-approval-request') return event.id;
  return createHash('sha256')
    .update(
      [
        'merge-approval-request',
        event.tags.find((tag) => tag[0] === 'h')?.[1] ?? '',
        event.tags.find((tag) => tag[0] === 'repo')?.[1] ?? '',
        event.tags.find((tag) => tag[0] === 'branch')?.[1] ?? '',
        event.tags.find((tag) => tag[0] === 'tip')?.[1] ?? '',
      ].join('\u0000'),
    )
    .digest('hex');
}

function tagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

/**
 * Poll exactly one registered identity at a time.
 *
 * The relay applies one quota to this daemon. A full registry scan every tick
 * exhausts that quota and repeatedly aborts on the first identity. Round-robin
 * polling bounds the request rate, advances past failures, and preserves a
 * separate cursor for each member-scoped reader.
 */
export class RegisteredEventPoller {
  private cursor = 0;
  private polling = false;
  private backoffUntilMs = 0;
  private readonly initialSince: number;

  constructor(
    private readonly registry: TokenRegistry,
    private readonly readerForPubkey: (pubkey: string) => RelayEventReader,
    private readonly handleEvent: (
      event: NostrEvent,
      recipientPubkey: string,
      reader: RelayEventReader,
    ) => Promise<void>,
    private readonly deliveryState: DeliveryState,
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
    const since = this.deliveryState.cursorFor(recipientPubkey, this.initialSince);
    let newestCreatedAt = since;
    const reader = this.readerForPubkey(recipientPubkey);
    this.polling = true;

    try {
      const events = await reader.query(registeredEventFilters(since));
      events.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
      for (const event of events) {
        newestCreatedAt = Math.max(newestCreatedAt, event.created_at);
        if (this.deliveryState.isBehindCursor(recipientPubkey, event.created_at)) continue;
        await this.handleEvent(event, recipientPubkey, reader.forEvent?.(event) ?? reader);
      }
      await this.deliveryState.advanceCursor(recipientPubkey, newestCreatedAt);
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
    private readonly deliveryState: DeliveryState,
    private readonly metadata = new NotificationMetadataResolver(),
  ) {}

  /** One concise, greppable line per candidate event — the gateway's whole audit trail. */
  private trace(
    event: NostrEvent,
    recipientPubkey: string | undefined,
    verdict: 'notify' | 'skip',
    reason: string,
    details: Record<string, string | number> = {},
  ): void {
    const channelId = event.tags.find((tag) => tag[0] === 'h')?.[1];
    const fields: Record<string, string | number> = {
      event: event.id,
      kind: event.kind,
      room: channelId ?? '-',
      recipient: recipientPubkey ?? '-',
      verdict,
      reason,
      ...details,
    };
    console.log(
      `[push] decision ${Object.entries(fields)
        .map(([key, value]) => `${key}=${logValue(value)}`)
        .join(' ')}`,
    );
  }

  async handleRelayEvent(
    event: NostrEvent,
    recipientPubkey: string,
    reader: RelayEventReader,
  ): Promise<void> {
    this.metadata.invalidate(event);
    if (event.kind === KIND_CORNER_STATE) {
      const record = parseCornerStateRecord(event);
      if (!record) {
        this.trace(event, recipientPubkey, 'skip', 'not-notifiable-kind');
        return;
      }
      // Automatic retry turns briefly say `working`; that is not human
      // acknowledgement and must not re-arm the same stuck-loop alert. Idle
      // and terminal lifecycle facts are the durable episode boundaries.
      const resolved =
        record.state === 'idle' || record.state === 'concluded' || record.state === 'closed';
      if (resolved) {
        await this.deliveryState.clearAttention(record.cornerId, recipientPubkey);
      }
      this.trace(
        event,
        recipientPubkey,
        'skip',
        resolved
          ? 'corner-attention-resolved'
          : record.state === 'waiting'
            ? 'corner-attention-standing'
            : 'corner-lifecycle-observed',
        { corner: record.cornerId, state: record.state },
      );
      return;
    }
    const channelId = event.tags.find((tag) => tag[0] === 'h')?.[1];
    if (!channelId) {
      this.trace(event, recipientPubkey, 'skip', 'no-channel');
      return;
    }
    const mention = mentionsMember(event, recipientPubkey);
    if (event.kind !== 9) {
      this.trace(
        event,
        recipientPubkey,
        'skip',
        event.kind === 9000 ? 'fatigue-policy-member-join' : 'not-notifiable-kind',
      );
      return;
    }
    if (recipientPubkey === event.pubkey) {
      this.trace(event, recipientPubkey, 'skip', 'sender-self');
      return;
    }

    // The database feed admitted this row through the registered identity's
    // active channel membership. Deliver only to that recipient's devices.
    const tokens = this.registry.tokensForPubkeys([recipientPubkey]);
    if (tokens.length === 0) {
      this.trace(event, recipientPubkey, 'skip', 'no-devices');
      return;
    }

    let context;
    try {
      context = await this.metadata.resolve(event, reader);
    } catch (error) {
      this.trace(event, recipientPubkey, 'skip', 'metadata-error', {
        error: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160),
      });
      // Preserve the existing retry contract. A transient metadata failure must
      // not advance the recipient cursor and lose the notification forever.
      throw error;
    }
    // Split the suppression gate's two halves so the audit line names the real
    // cause; isSuppressedFixtureNotification checks persistence first anyway.
    if (context.persistentWorkspaceRoom !== true) {
      this.trace(event, recipientPubkey, 'skip', 'room-not-persistent-workspace');
      return;
    }
    if (isSuppressedFixtureNotification(event, context)) {
      this.trace(event, recipientPubkey, 'skip', 'fixture-suppressed');
      return;
    }
    const plan: PushNotificationPlan | null = mapEventToNotification(event, context, {
      recipientMentioned: mention,
    });
    if (!plan) {
      this.trace(event, recipientPubkey, 'skip', 'fatigue-policy-ambient');
      return;
    }

    // Claim durably before FCM. An ambiguous network result is never retried:
    // at-most-once delivery is more important than risking a duplicate alert.
    const notificationType = plan.data.type ?? 'channel-activity';
    const dedupeKey = deliveryKey(event, notificationType);
    let reserved: boolean;
    try {
      reserved =
        notificationType === 'actionable-failure'
          ? await this.deliveryState.reserveAttentionAttempt({
              eventId: dedupeKey,
              eventCreatedAt: event.created_at,
              pubkey: recipientPubkey,
              sourceId: plan.data.cornerId ?? plan.channelId,
              reason:
                tagValue(event, 'reason') ??
                tagValue(event, 'delivery') ??
                tagValue(event, 'status') ??
                'needs-attention',
            })
          : await this.deliveryState.reserveAttempt(dedupeKey, event.created_at, recipientPubkey);
    } catch (error) {
      this.trace(event, recipientPubkey, 'skip', 'delivery-state-error', {
        error: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160),
      });
      throw error;
    }
    if (!reserved) {
      this.trace(
        event,
        recipientPubkey,
        'skip',
        notificationType === 'actionable-failure' ? 'attention-coalesced' : 'already-attempted',
      );
      return;
    }

    const androidChannelId =
      plan.data.type === 'mention'
        ? 'mentions'
        : plan.data.type === 'direct-message'
          ? 'activity'
          : 'attention';
    let result: BatchResponse;
    try {
      result = await this.messaging.sendEachForMulticast({
        tokens,
        notification: { title: plan.title, body: plan.body },
        data: plan.data,
        android: {
          collapseKey: plan.channelId,
          priority: 'high',
          notification: { channelId: androidChannelId, tag: `room:${plan.channelId}` },
        },
      });
    } catch (error) {
      this.trace(event, recipientPubkey, 'skip', 'fcm-error', {
        recipients: 1,
        devices: tokens.length,
        error: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160),
      });
      throw error;
    }

    // Emit the candidate's sole decision line as soon as FCM returns. Durable
    // bookkeeping failures are separately reported by the poll loop without
    // creating a second, contradictory event decision.
    this.trace(event, recipientPubkey, 'notify', 'fcm-result', {
      type: notificationType,
      recipients: 1,
      devices: tokens.length,
      success: result.successCount,
      failure: result.failureCount,
    });
    await this.deliveryState.markDelivered(dedupeKey, recipientPubkey);
    await this.removePermanentFailures(tokens, result);
  }

  /**
   * Operator proof-of-delivery: send one real notification to every registered
   * device of one pubkey and report per-device results. Never touches the
   * durable delivery state — a test send must not consume or suppress anything.
   */
  async sendTestNotification(recipientPubkey: string): Promise<TestSendReport> {
    const tokens = this.registry.tokensForPubkeys([recipientPubkey]);
    if (tokens.length === 0) {
      console.log(
        `[push] test-send recipient=${recipientPubkey.slice(0, 12)} verdict=skip reason=no-devices`,
      );
      return { pubkey: recipientPubkey, successCount: 0, failureCount: 0, devices: [] };
    }
    const result = await this.messaging.sendEachForMulticast({
      tokens,
      notification: {
        title: 'Beeline push test',
        body: 'Delivery test from the Beeline push gateway.',
      },
      data: { type: 'delivery-test' },
      android: { priority: 'high', notification: { channelId: 'messages' } },
    });
    const devices: TestDeviceResult[] = tokens.map((token, index) => {
      const response = result.responses[index];
      return response?.success
        ? { deviceId: deviceId(token), ok: true, messageId: response.messageId }
        : {
            deviceId: deviceId(token),
            ok: false,
            error: response?.error?.code ?? response?.error?.message ?? 'unknown FCM failure',
          };
    });
    console.log(
      `[push] test-send recipient=${recipientPubkey.slice(0, 12)} verdict=notify devices=${tokens.length} success=${result.successCount} failure=${result.failureCount}`,
    );
    return {
      pubkey: recipientPubkey,
      successCount: result.successCount,
      failureCount: result.failureCount,
      devices,
    };
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
