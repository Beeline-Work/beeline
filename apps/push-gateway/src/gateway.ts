import type { BuzzClient } from '@beeline/buzz-client';
import type { NostrEvent } from '@beeline/nostr';
import type { BatchResponse, Messaging } from 'firebase-admin/messaging';
import { mapEventToNotification } from './mapping.js';
import { TokenRegistry } from './registry.js';

const PERMANENT_TOKEN_ERRORS = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
]);

export class PushGateway {
  constructor(
    private readonly client: BuzzClient,
    private readonly registry: TokenRegistry,
    private readonly messaging: Messaging,
  ) {}

  async handleRelayEvent(event: NostrEvent, reader: BuzzClient = this.client): Promise<void> {
    const channelId = event.tags.find((tag) => tag[0] === 'h')?.[1];
    if (!channelId) return;

    const [members, metadata] = await Promise.all([
      reader.listMembers(channelId),
      reader.getChannelMetadata(channelId),
    ]);
    const plan = mapEventToNotification(event, metadata?.name);
    if (!plan) return;

    const recipients = members
      .map((member) => member.pubkey)
      .filter((pubkey) => pubkey !== event.pubkey);
    const tokens = this.registry.tokensForPubkeys(recipients);
    if (tokens.length === 0) return;

    const result = await this.messaging.sendEachForMulticast({
      tokens,
      notification: { title: plan.title, body: plan.body },
      data: plan.data,
      android: {
        priority: 'high',
        notification: { channelId: 'messages' },
      },
    });

    await this.removePermanentFailures(tokens, result);
    console.log(
      `[push] FCM sent event=${event.id.slice(0, 12)} channel=${channelId} recipients=${tokens.length} success=${result.successCount} failure=${result.failureCount}`,
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
